const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'db.json');

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

let _db = null;
let _counters = {};

function load() {
    if (_db) return _db;
    if (fs.existsSync(dbPath)) {
        try {
            const d = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
            _db = d.tables || {};
            _counters = d.counters || {};
            return _db;
        } catch (e) { console.error(e); }
    }
    _db = {}; _counters = {};
    return _db;
}

function save() {
    fs.writeFileSync(dbPath, JSON.stringify({ tables: _db, counters: _counters }, null, 2));
}

function ensure(name) { load(); if (!_db[name]) _db[name] = []; }
function nextId(name) { ensure(name); _counters[name] = (_counters[name] || 0) + 1; return _counters[name]; }
function now() { return new Date().toISOString(); }

function listAll(table, filter) {
    ensure(table);
    return filter ? _db[table].filter(filter) : [..._db[table]];
}
function findById(table, id) { ensure(table); return _db[table].find(r => r.id === id); }
function findOne(table, filter) { ensure(table); return _db[table].find(filter); }

function insertRow(table, row) {
    ensure(table);
    const r = { id: nextId(table), created_at: now(), ...row };
    _db[table].push(r); save(); return r;
}
function updateRows(table, filter, updates) {
    ensure(table);
    let n = 0;
    _db[table] = _db[table].map(r => { if (filter(r)) { n++; return { ...r, ...updates }; } return r; });
    save(); return n;
}

function initDB() {
    load();
    [
        'generator_unit', 'drill_plan', 'load_switch_record', 'fuel_level_record',
        'recovery_record', 'system_config', 'alarm_record',
        'non_compliance_item', 'review_todo', 'load_curve_point'
    ].forEach(ensure);
    if (_db.generator_unit.length === 0) {
        insertRow('generator_unit', { unit_code: 'GEN-001', unit_name: '1号柴油发电机组', capacity_kw: 800, fuel_tank_capacity_l: 5000, status: 'normal' });
        insertRow('generator_unit', { unit_code: 'GEN-002', unit_name: '2号柴油发电机组', capacity_kw: 1000, fuel_tank_capacity_l: 6000, status: 'normal' });
        insertRow('generator_unit', { unit_code: 'GEN-003', unit_name: '3号柴油发电机组', capacity_kw: 1200, fuel_tank_capacity_l: 8000, status: 'maintenance' });
    }
    if (_db.system_config.length === 0) {
        insertRow('system_config', { config_key: 'ups_margin_threshold', config_value: '30', description: 'UPS余量阈值(%)', updated_at: now() });
        insertRow('system_config', { config_key: 'fuel_level_threshold', config_value: '20', description: '油位阈值(%)', updated_at: now() });
        insertRow('system_config', { config_key: 'load_deviation_threshold', config_value: '10', description: '负载偏差阈值(%)', updated_at: now() });
        insertRow('system_config', { config_key: 'switch_time_target_min', config_value: '5', description: '切换时间目标(分钟)', updated_at: now() });
    }
    save();
}

function enrichDrillPlan(p) {
    if (!p) return p;
    const unit = findOne('generator_unit', u => u.id === p.unit_id);
    return {
        ...p,
        unit_code: unit?.unit_code,
        unit_name: unit?.unit_name,
        capacity_kw: unit?.capacity_kw,
        fuel_tank_capacity_l: unit?.fuel_tank_capacity_l,
        unit_status: unit?.status,
        load_record_count: listAll('load_switch_record', r => r.drill_plan_id === p.id).length,
        fuel_record_count: listAll('fuel_level_record', r => r.drill_plan_id === p.id).length,
        alarm_count: listAll('alarm_record', r => r.drill_plan_id === p.id).length,
        non_compliance_count: listAll('non_compliance_item', r => r.drill_plan_id === p.id).length,
        review_todo_count: listAll('review_todo', r => r.drill_plan_id === p.id).length,
        recovery_confirmed: listAll('recovery_record', r => r.drill_plan_id === p.id).length
    };
}

function isUnitLockedByDrill(unitId) {
    const activeDrills = listAll('drill_plan', p =>
        p.unit_id === unitId &&
        (p.status === 'in_progress' || p.status === 'load_switched')
    );
    return activeDrills.length > 0;
}

function deleteRows(table, filter) {
    ensure(table);
    const before = _db[table].length;
    _db[table] = _db[table].filter(r => !filter(r));
    const deleted = before - _db[table].length;
    if (deleted > 0) save();
    return deleted;
}

initDB();

module.exports = {
    listAll, findById, findOne, insertRow, updateRows, deleteRows,
    enrichDrillPlan, isUnitLockedByDrill,
    getConfig(key) {
        const c = findOne('system_config', c => c.config_key === key);
        return c ? parseFloat(c.config_value) : null;
    }
};
