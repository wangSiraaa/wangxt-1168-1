const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.API_PORT || 19468;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const ROLES = {
    DUTY_OPERATOR: 'duty_operator',
    FACILITY_ENGINEER: 'facility_engineer',
    SAFETY_MANAGER: 'safety_manager'
};

const DRILL_STATUS = {
    PENDING: 'pending',
    IN_PROGRESS: 'in_progress',
    LOAD_SWITCHED: 'load_switched',
    RECOVERY_CONFIRMED: 'recovery_confirmed',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled'
};

function generatePlanCode() {
    const date = new Date();
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
    const seq = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    return `DRILL-${dateStr}-${seq}`;
}

function getRoleName(role) {
    const names = {
        [ROLES.DUTY_OPERATOR]: '运维值班员',
        [ROLES.FACILITY_ENGINEER]: '设施工程师',
        [ROLES.SAFETY_MANAGER]: '安全经理'
    };
    return names[role] || role;
}

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/roles', (req, res) => {
    res.json({
        roles: [
            { code: ROLES.DUTY_OPERATOR, name: '运维值班员' },
            { code: ROLES.FACILITY_ENGINEER, name: '设施工程师' },
            { code: ROLES.SAFETY_MANAGER, name: '安全经理' }
        ]
    });
});

app.get('/api/config', (req, res) => {
    const configs = db.listAll('system_config').map(c => ({
        config_key: c.config_key, config_value: c.config_value, description: c.description
    }));
    res.json({ configs });
});

app.get('/api/generator-units', (req, res) => {
    const units = db.listAll('generator_unit').sort((a, b) => a.id - b.id);
    res.json({ units });
});

app.post('/api/generator-units', (req, res) => {
    const { unit_code, unit_name, capacity_kw, fuel_tank_capacity_l } = req.body;
    if (!unit_code || !unit_name || !capacity_kw || !fuel_tank_capacity_l) {
        return res.status(400).json({ error: '缺少必要参数' });
    }
    try {
        const r = db.insertRow('generator_unit', { unit_code, unit_name, capacity_kw, fuel_tank_capacity_l, status: 'normal' });
        res.json({ id: r.id, unit_code, unit_name, capacity_kw, fuel_tank_capacity_l });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/generator-units/:id/status', (req, res) => {
    const { status } = req.body;
    const role = req.headers['x-user-role'] || ROLES.FACILITY_ENGINEER;
    if (role !== ROLES.FACILITY_ENGINEER && role !== ROLES.SAFETY_MANAGER) {
        return res.status(403).json({ error: '只有设施工程师或安全经理可以修改机组状态' });
    }
    if (!status) {
        return res.status(400).json({ error: '缺少状态参数' });
    }
    const uid = parseInt(req.params.id);
    const unit = db.findById('generator_unit', uid);
    if (!unit) {
        return res.status(404).json({ error: '机组不存在' });
    }
    if (db.isUnitLockedByDrill(uid)) {
        return res.status(400).json({ error: '该机组正在进行演练，状态已锁定，不能修改' });
    }
    db.updateRows('generator_unit', u => u.id === uid, { status });
    res.json({ id: uid, status, message: '机组状态已更新' });
});

app.get('/api/generator-units/:id/lock-status', (req, res) => {
    const uid = parseInt(req.params.id);
    const unit = db.findById('generator_unit', uid);
    if (!unit) {
        return res.status(404).json({ error: '机组不存在' });
    }
    const locked = db.isUnitLockedByDrill(uid);
    res.json({ unit_id: uid, locked, status: unit.status });
});

app.get('/api/drill-plans', (req, res) => {
    const plans = db.listAll('drill_plan')
        .sort((a, b) => b.id - a.id)
        .map(p => db.enrichDrillPlan(p));
    res.json({ plans });
});

app.get('/api/drill-plans/:id', (req, res) => {
    const pid = parseInt(req.params.id);
    const plan = db.findById('drill_plan', pid);
    if (!plan) {
        return res.status(404).json({ error: '演练计划不存在' });
    }
    const enriched = db.enrichDrillPlan(plan);
    const loadRecords = db.listAll('load_switch_record', r => r.drill_plan_id === pid).sort((a, b) => a.id - b.id);
    const fuelRecords = db.listAll('fuel_level_record', r => r.drill_plan_id === pid).sort((a, b) => a.id - b.id);
    const recoveryRecord = db.findOne('recovery_record', r => r.drill_plan_id === pid);
    res.json({ plan: enriched, load_records: loadRecords, fuel_records: fuelRecords, recovery_record: recoveryRecord });
});

app.post('/api/drill-plans', (req, res) => {
    const { plan_name, unit_id, initiator, planned_start_time, ups_margin_percent, remarks } = req.body;
    if (!plan_name || !unit_id || !initiator) {
        return res.status(400).json({ error: '缺少必要参数' });
    }
    const role = req.headers['x-user-role'] || ROLES.DUTY_OPERATOR;
    if (role !== ROLES.DUTY_OPERATOR) {
        return res.status(403).json({ error: '只有运维值班员可以发起演练计划' });
    }
    const unit = db.findById('generator_unit', unit_id);
    if (!unit) {
        return res.status(404).json({ error: '机组不存在' });
    }
    if (unit.status !== 'normal') {
        return res.status(400).json({ error: `机组当前状态为 ${unit.status}，无法进行演练` });
    }
    const upsThreshold = db.getConfig('ups_margin_threshold') || 30;
    if (ups_margin_percent !== undefined && ups_margin_percent !== null) {
        if (ups_margin_percent < upsThreshold) {
            return res.status(400).json({ 
                error: `UPS余量不足，当前 ${ups_margin_percent}%，阈值为 ${upsThreshold}%，不能开始演练` 
            });
        }
    }
    const planCode = generatePlanCode();
    const r = db.insertRow('drill_plan', {
        plan_code: planCode, plan_name, unit_id, initiator, initiator_role: role,
        planned_start_time: planned_start_time || null,
        ups_margin_percent: ups_margin_percent !== undefined ? ups_margin_percent : null,
        status: DRILL_STATUS.PENDING, remarks: remarks || null
    });
    res.json({ id: r.id, plan_code: planCode, plan_name, unit_id, status: DRILL_STATUS.PENDING, message: '演练计划创建成功' });
});

app.post('/api/drill-plans/:id/start', (req, res) => {
    const { ups_margin_percent } = req.body;
    const role = req.headers['x-user-role'] || ROLES.DUTY_OPERATOR;
    if (role !== ROLES.DUTY_OPERATOR) {
        return res.status(403).json({ error: '只有运维值班员可以开始演练' });
    }
    const pid = parseInt(req.params.id);
    const plan = db.findById('drill_plan', pid);
    if (!plan) {
        return res.status(404).json({ error: '演练计划不存在' });
    }
    if (plan.status !== DRILL_STATUS.PENDING) {
        return res.status(400).json({ error: '演练计划状态不允许开始' });
    }
    const unit = db.findById('generator_unit', plan.unit_id);
    if (unit && unit.status !== 'normal') {
        return res.status(400).json({ error: `机组当前状态为 ${unit.status}，无法开始演练` });
    }
    const upsThreshold = db.getConfig('ups_margin_threshold') || 30;
    const finalUpsMargin = ups_margin_percent !== undefined ? ups_margin_percent : plan.ups_margin_percent;
    if (finalUpsMargin === null || finalUpsMargin === undefined) {
        return res.status(400).json({ error: '必须提供UPS余量数据' });
    }
    if (finalUpsMargin < upsThreshold) {
        return res.status(400).json({ 
            error: `UPS余量不足，当前 ${finalUpsMargin}%，阈值为 ${upsThreshold}%，不能开始演练` 
        });
    }
    const now = new Date().toISOString();
    db.updateRows('drill_plan', p => p.id === pid, {
        status: DRILL_STATUS.IN_PROGRESS, actual_start_time: now, ups_margin_percent: finalUpsMargin
    });
    res.json({ id: pid, status: DRILL_STATUS.IN_PROGRESS, actual_start_time: now, message: '演练已开始' });
});

app.post('/api/drill-plans/:id/load-switch', (req, res) => {
    const { switch_type, load_kw, switch_time, recorded_by, fuel_level_l, alarms, load_curve } = req.body;
    const role = req.headers['x-user-role'] || ROLES.FACILITY_ENGINEER;
    if (role !== ROLES.FACILITY_ENGINEER && role !== ROLES.DUTY_OPERATOR) {
        return res.status(403).json({ error: '只有设施工程师或运维值班员可以记录负载切换' });
    }
    if (!switch_type || !load_kw || !switch_time || !recorded_by) {
        return res.status(400).json({ error: '缺少必要参数' });
    }
    const pid = parseInt(req.params.id);
    const plan = db.findById('drill_plan', pid);
    if (!plan) {
        return res.status(404).json({ error: '演练计划不存在' });
    }
    if (plan.status !== DRILL_STATUS.IN_PROGRESS && plan.status !== DRILL_STATUS.LOAD_SWITCHED) {
        return res.status(400).json({ error: '演练计划状态不允许记录负载切换' });
    }
    const recovery = db.findOne('recovery_record', r => r.drill_plan_id === pid);
    if (recovery) {
        return res.status(400).json({ error: '市电已恢复确认，不能修改切换时间' });
    }
    const r = db.insertRow('load_switch_record', {
        drill_plan_id: pid, unit_id: plan.unit_id, switch_type, load_kw, switch_time, recorded_by, is_locked: 0
    });
    let fuelRecord = null;
    if (fuel_level_l !== undefined && fuel_level_l !== null) {
        const unit = db.findById('generator_unit', plan.unit_id);
        const fuelTankCap = unit?.fuel_tank_capacity_l || 0;
        const fuelPercent = fuelTankCap > 0 ? Math.round((fuel_level_l / fuelTankCap) * 10000) / 100 : 0;
        const fuelThreshold = db.getConfig('fuel_level_threshold') || 20;
        const belowThreshold = fuelPercent < fuelThreshold ? 1 : 0;
        const now = new Date().toISOString();
        fuelRecord = db.insertRow('fuel_level_record', {
            drill_plan_id: pid, unit_id: plan.unit_id, fuel_level_l, fuel_level_percent: fuelPercent,
            below_threshold: belowThreshold, recorded_by, recorded_at: now, load_switch_id: r.id
        });
    }
    let alarmRecords = [];
    if (alarms && Array.isArray(alarms) && alarms.length > 0) {
        const now = new Date().toISOString();
        alarms.forEach(alarm => {
            const alarmRec = db.insertRow('alarm_record', {
                drill_plan_id: pid,
                unit_id: plan.unit_id,
                load_switch_id: r.id,
                alarm_type: alarm.alarm_type || 'general',
                alarm_level: alarm.alarm_level || 'warning',
                description: alarm.description || '',
                handled: 0,
                reported_by: recorded_by,
                reported_at: now
            });
            alarmRecords.push(alarmRec);
        });
    }
    let curvePoints = [];
    if (load_curve && Array.isArray(load_curve) && load_curve.length > 0) {
        load_curve.forEach((point, idx) => {
            const cp = db.insertRow('load_curve_point', {
                drill_plan_id: pid,
                load_switch_id: r.id,
                point_index: idx,
                timestamp: point.timestamp || null,
                load_kw: point.load_kw || 0
            });
            curvePoints.push(cp);
        });
    }
    db.updateRows('drill_plan', p => p.id === pid && p.status === DRILL_STATUS.IN_PROGRESS, { status: DRILL_STATUS.LOAD_SWITCHED });
    res.json({
        id: r.id,
        fuel_record: fuelRecord,
        alarm_count: alarmRecords.length,
        curve_point_count: curvePoints.length,
        message: '负载切换记录已保存，油位、告警和负载曲线已关联记录'
    });
});

app.put('/api/load-switch-records/:id', (req, res) => {
    const { switch_type, load_kw, switch_time, recorded_by } = req.body;
    const role = req.headers['x-user-role'] || ROLES.FACILITY_ENGINEER;
    if (role !== ROLES.FACILITY_ENGINEER && role !== ROLES.DUTY_OPERATOR) {
        return res.status(403).json({ error: '只有设施工程师或运维值班员可以修改负载切换记录' });
    }
    const rid = parseInt(req.params.id);
    const record = db.findById('load_switch_record', rid);
    if (!record) {
        return res.status(404).json({ error: '负载切换记录不存在' });
    }
    if (record.is_locked === 1) {
        return res.status(400).json({ error: '市电已恢复确认，切换时间已锁定，不能修改' });
    }
    const recovery = db.findOne('recovery_record', r => r.drill_plan_id === record.drill_plan_id);
    if (recovery) {
        return res.status(400).json({ error: '市电已恢复确认，不能修改切换时间' });
    }
    db.updateRows('load_switch_record', r => r.id === rid, {
        switch_type: switch_type || record.switch_type,
        load_kw: load_kw !== undefined ? load_kw : record.load_kw,
        switch_time: switch_time || record.switch_time,
        recorded_by: recorded_by || record.recorded_by
    });
    res.json({ message: '负载切换记录已更新' });
});

app.post('/api/drill-plans/:id/fuel-level', (req, res) => {
    const { fuel_level_l, recorded_by } = req.body;
    const role = req.headers['x-user-role'] || ROLES.FACILITY_ENGINEER;
    if (role !== ROLES.FACILITY_ENGINEER) {
        return res.status(403).json({ error: '只有设施工程师可以记录油位' });
    }
    if (fuel_level_l === undefined || fuel_level_l === null || !recorded_by) {
        return res.status(400).json({ error: '缺少必要参数' });
    }
    const pid = parseInt(req.params.id);
    const plan = db.findById('drill_plan', pid);
    if (!plan) {
        return res.status(404).json({ error: '演练计划不存在' });
    }
    if (plan.status !== DRILL_STATUS.IN_PROGRESS && plan.status !== DRILL_STATUS.LOAD_SWITCHED) {
        return res.status(400).json({ error: '演练计划状态不允许记录油位' });
    }
    const unit = db.findById('generator_unit', plan.unit_id);
    const fuelTankCap = unit?.fuel_tank_capacity_l || 0;
    const fuelPercent = fuelTankCap > 0 ? Math.round((fuel_level_l / fuelTankCap) * 10000) / 100 : 0;
    const fuelThreshold = db.getConfig('fuel_level_threshold') || 20;
    const belowThreshold = fuelPercent < fuelThreshold ? 1 : 0;
    const now = new Date().toISOString();
    const r = db.insertRow('fuel_level_record', {
        drill_plan_id: pid, unit_id: plan.unit_id, fuel_level_l, fuel_level_percent: fuelPercent,
        below_threshold: belowThreshold, recorded_by, recorded_at: now
    });
    let warning = null;
    if (belowThreshold === 1) {
        warning = `油位 ${fuelPercent}% 低于阈值 ${fuelThreshold}%，请及时补油！`;
    }
    res.json({ id: r.id, fuel_level_percent: fuelPercent, below_threshold: belowThreshold === 1, warning, message: '油位记录已保存' });
});

app.get('/api/drill-plans/:id/alarms', (req, res) => {
    const pid = parseInt(req.params.id);
    const plan = db.findById('drill_plan', pid);
    if (!plan) {
        return res.status(404).json({ error: '演练计划不存在' });
    }
    const alarms = db.listAll('alarm_record', a => a.drill_plan_id === pid).sort((a, b) => a.id - b.id);
    res.json({ alarms });
});

app.post('/api/drill-plans/:id/alarms', (req, res) => {
    const { alarm_type, alarm_level, description, reported_by } = req.body;
    const role = req.headers['x-user-role'] || ROLES.FACILITY_ENGINEER;
    if (role !== ROLES.FACILITY_ENGINEER && role !== ROLES.DUTY_OPERATOR && role !== ROLES.SAFETY_MANAGER) {
        return res.status(403).json({ error: '无权限添加告警记录' });
    }
    if (!alarm_type || !description || !reported_by) {
        return res.status(400).json({ error: '缺少必要参数' });
    }
    const pid = parseInt(req.params.id);
    const plan = db.findById('drill_plan', pid);
    if (!plan) {
        return res.status(404).json({ error: '演练计划不存在' });
    }
    if (plan.status === DRILL_STATUS.COMPLETED || plan.status === DRILL_STATUS.CANCELLED) {
        return res.status(400).json({ error: '演练已结束，不能添加告警' });
    }
    const now = new Date().toISOString();
    const r = db.insertRow('alarm_record', {
        drill_plan_id: pid, unit_id: plan.unit_id,
        alarm_type, alarm_level: alarm_level || 'warning',
        description, handled: 0, reported_by, reported_at: now
    });
    res.json({ id: r.id, message: '告警记录已添加' });
});

app.put('/api/alarms/:id/handle', (req, res) => {
    const { handled_by, handle_remark } = req.body;
    const role = req.headers['x-user-role'] || ROLES.FACILITY_ENGINEER;
    if (role !== ROLES.FACILITY_ENGINEER && role !== ROLES.SAFETY_MANAGER) {
        return res.status(403).json({ error: '只有设施工程师或安全经理可以处理告警' });
    }
    const aid = parseInt(req.params.id);
    const alarm = db.findById('alarm_record', aid);
    if (!alarm) {
        return res.status(404).json({ error: '告警记录不存在' });
    }
    if (alarm.handled === 1) {
        return res.status(400).json({ error: '告警已处理，不能重复处理' });
    }
    const now = new Date().toISOString();
    db.updateRows('alarm_record', a => a.id === aid, {
        handled: 1, handled_by: handled_by || null,
        handle_remark: handle_remark || null, handled_at: now
    });
    res.json({ id: aid, message: '告警已处理' });
});

app.get('/api/drill-plans/:id/load-curve', (req, res) => {
    const pid = parseInt(req.params.id);
    const plan = db.findById('drill_plan', pid);
    if (!plan) {
        return res.status(404).json({ error: '演练计划不存在' });
    }
    const points = db.listAll('load_curve_point', p => p.drill_plan_id === pid)
        .sort((a, b) => a.id - b.id);
    res.json({ points });
});

app.get('/api/drill-plans/:id/non-compliance', (req, res) => {
    const pid = parseInt(req.params.id);
    const plan = db.findById('drill_plan', pid);
    if (!plan) {
        return res.status(404).json({ error: '演练计划不存在' });
    }
    const items = db.listAll('non_compliance_item', i => i.drill_plan_id === pid)
        .sort((a, b) => a.id - b.id);
    res.json({ items });
});

app.post('/api/drill-plans/:id/non-compliance', (req, res) => {
    const { category, description, severity, found_by } = req.body;
    const role = req.headers['x-user-role'] || ROLES.SAFETY_MANAGER;
    if (role !== ROLES.SAFETY_MANAGER) {
        return res.status(403).json({ error: '只有安全经理可以添加未达标项' });
    }
    if (!category || !description) {
        return res.status(400).json({ error: '缺少必要参数' });
    }
    const pid = parseInt(req.params.id);
    const plan = db.findById('drill_plan', pid);
    if (!plan) {
        return res.status(404).json({ error: '演练计划不存在' });
    }
    const now = new Date().toISOString();
    const r = db.insertRow('non_compliance_item', {
        drill_plan_id: pid, category, description,
        severity: severity || 'medium', status: 'open',
        found_by: found_by || null, found_at: now
    });
    res.json({ id: r.id, message: '未达标项已添加' });
});

app.put('/api/non-compliance/:id', (req, res) => {
    const { status, rectification_measure, closed_by } = req.body;
    const role = req.headers['x-user-role'] || ROLES.SAFETY_MANAGER;
    if (role !== ROLES.SAFETY_MANAGER) {
        return res.status(403).json({ error: '只有安全经理可以修改未达标项' });
    }
    const nid = parseInt(req.params.id);
    const item = db.findById('non_compliance_item', nid);
    if (!item) {
        return res.status(404).json({ error: '未达标项不存在' });
    }
    const updates = {};
    if (status) updates.status = status;
    if (rectification_measure) updates.rectification_measure = rectification_measure;
    if (closed_by && status === 'closed') {
        updates.closed_by = closed_by;
        updates.closed_at = new Date().toISOString();
    }
    db.updateRows('non_compliance_item', i => i.id === nid, updates);
    res.json({ id: nid, message: '未达标项已更新' });
});

app.get('/api/drill-plans/:id/review-todos', (req, res) => {
    const pid = parseInt(req.params.id);
    const plan = db.findById('drill_plan', pid);
    if (!plan) {
        return res.status(404).json({ error: '演练计划不存在' });
    }
    const todos = db.listAll('review_todo', t => t.drill_plan_id === pid)
        .sort((a, b) => a.id - b.id);
    res.json({ todos });
});

app.post('/api/drill-plans/:id/review-todos', (req, res) => {
    const { content, assignee, priority, due_date, created_by } = req.body;
    const role = req.headers['x-user-role'] || ROLES.SAFETY_MANAGER;
    if (role !== ROLES.SAFETY_MANAGER) {
        return res.status(403).json({ error: '只有安全经理可以添加复盘待办' });
    }
    if (!content) {
        return res.status(400).json({ error: '缺少待办内容' });
    }
    const pid = parseInt(req.params.id);
    const plan = db.findById('drill_plan', pid);
    if (!plan) {
        return res.status(404).json({ error: '演练计划不存在' });
    }
    const now = new Date().toISOString();
    const r = db.insertRow('review_todo', {
        drill_plan_id: pid, content, assignee: assignee || null,
        priority: priority || 'medium', due_date: due_date || null,
        status: 'pending', created_by: created_by || null, created_at: now
    });
    res.json({ id: r.id, message: '复盘待办已添加' });
});

app.put('/api/review-todos/:id', (req, res) => {
    const { status, completed_by, completion_remark } = req.body;
    const role = req.headers['x-user-role'] || ROLES.SAFETY_MANAGER;
    if (role !== ROLES.SAFETY_MANAGER && role !== ROLES.FACILITY_ENGINEER) {
        return res.status(403).json({ error: '无权限修改复盘待办' });
    }
    const tid = parseInt(req.params.id);
    const todo = db.findById('review_todo', tid);
    if (!todo) {
        return res.status(404).json({ error: '复盘待办不存在' });
    }
    const updates = {};
    if (status) updates.status = status;
    if (status === 'completed') {
        updates.completed_by = completed_by || null;
        updates.completed_at = new Date().toISOString();
        if (completion_remark) updates.completion_remark = completion_remark;
    }
    db.updateRows('review_todo', t => t.id === tid, updates);
    res.json({ id: tid, message: '复盘待办已更新' });
});

app.post('/api/drill-plans/:id/confirm-recovery', (req, res) => {
    const { recovery_time, confirmed_by } = req.body;
    const role = req.headers['x-user-role'] || ROLES.SAFETY_MANAGER;
    if (role !== ROLES.SAFETY_MANAGER) {
        return res.status(403).json({ error: '只有安全经理可以确认市电恢复' });
    }
    if (!recovery_time || !confirmed_by) {
        return res.status(400).json({ error: '缺少必要参数' });
    }
    const pid = parseInt(req.params.id);
    const plan = db.findById('drill_plan', pid);
    if (!plan) {
        return res.status(404).json({ error: '演练计划不存在' });
    }
    if (plan.status !== DRILL_STATUS.LOAD_SWITCHED && plan.status !== DRILL_STATUS.IN_PROGRESS) {
        return res.status(400).json({ error: '演练计划状态不允许确认恢复' });
    }
    const existingRecovery = db.findOne('recovery_record', r => r.drill_plan_id === pid);
    if (existingRecovery) {
        return res.status(400).json({ error: '该演练计划已确认过市电恢复' });
    }
    const now = new Date().toISOString();
    db.insertRow('recovery_record', {
        drill_plan_id: pid, utility_power_restored: 1, recovery_time, confirmed_by, confirmed_at: now
    });
    db.updateRows('load_switch_record', r => r.drill_plan_id === pid, { is_locked: 1 });
    db.updateRows('drill_plan', p => p.id === pid, { status: DRILL_STATUS.RECOVERY_CONFIRMED, actual_end_time: now });
    res.json({ message: '市电恢复已确认，切换时间已锁定，演练进入完成阶段' });
});

function generateNonComplianceAndTodos(planId) {
    const plan = db.findById('drill_plan', planId);
    if (!plan) return { nonComplianceCount: 0, todoCount: 0 };

    const existingNC = db.listAll('non_compliance_item', i => i.drill_plan_id === planId);
    const existingTodos = db.listAll('review_todo', t => t.drill_plan_id === planId);
    if (existingNC.length > 0 || existingTodos.length > 0) {
        return { nonComplianceCount: existingNC.length, todoCount: existingTodos.length, autoGenerated: false };
    }

    const unit = db.findById('generator_unit', plan.unit_id);
    const loadRecords = db.listAll('load_switch_record', r => r.drill_plan_id === planId).sort((a, b) => a.id - b.id);
    const fuelRecords = db.listAll('fuel_level_record', r => r.drill_plan_id === planId).sort((a, b) => a.id - b.id);
    const alarms = db.listAll('alarm_record', a => a.drill_plan_id === planId);
    const recovery = db.findOne('recovery_record', r => r.drill_plan_id === planId);
    const now = new Date().toISOString();

    const fuelThreshold = db.getConfig('fuel_level_threshold') || 20;
    const upsThreshold = db.getConfig('ups_margin_threshold') || 30;
    const switchTimeTargetMin = db.getConfig('switch_time_target_min') || 5;
    const loadDeviationThreshold = db.getConfig('load_deviation_threshold') || 10;

    let ncCount = 0;
    let todoCount = 0;

    if (plan.ups_margin_percent !== null && plan.ups_margin_percent !== undefined) {
        if (plan.ups_margin_percent < upsThreshold + 10) {
            const nc = db.insertRow('non_compliance_item', {
                drill_plan_id: planId,
                category: 'ups_margin',
                description: `UPS余量偏低，当前 ${plan.ups_margin_percent}%，建议提升冗余度`,
                severity: plan.ups_margin_percent < upsThreshold + 5 ? 'high' : 'medium',
                status: 'open',
                found_by: 'system',
                found_at: now,
                auto_generated: 1
            });
            ncCount++;
            const todo = db.insertRow('review_todo', {
                drill_plan_id: planId,
                content: '分析UPS余量偏低原因，制定扩容或优化方案',
                assignee: '设施工程师',
                priority: plan.ups_margin_percent < upsThreshold + 5 ? 'high' : 'medium',
                status: 'pending',
                created_by: 'system',
                created_at: now,
                auto_generated: 1
            });
            todoCount++;
        }
    }

    const lowFuelRecords = fuelRecords.filter(r => r.below_threshold === 1);
    if (lowFuelRecords.length > 0) {
        const nc = db.insertRow('non_compliance_item', {
            drill_plan_id: planId,
            category: 'fuel_level',
            description: `演练期间有 ${lowFuelRecords.length} 次油位低于阈值 ${fuelThreshold}%，存在供油风险`,
            severity: 'high',
            status: 'open',
            found_by: 'system',
            found_at: now,
            auto_generated: 1
        });
        ncCount++;
        const todo = db.insertRow('review_todo', {
            drill_plan_id: planId,
            content: '检查油箱补油机制，确保演练前油位处于安全水平',
            assignee: '设施工程师',
            priority: 'high',
            status: 'pending',
            created_by: 'system',
            created_at: now,
            auto_generated: 1
        });
        todoCount++;
    }

    if (alarms.length > 0) {
        const unhandled = alarms.filter(a => a.handled === 0);
        if (unhandled.length > 0) {
            const nc = db.insertRow('non_compliance_item', {
                drill_plan_id: planId,
                category: 'alarm_unhandled',
                description: `演练结束时有 ${unhandled.length} 条告警未处理`,
                severity: 'medium',
                status: 'open',
                found_by: 'system',
                found_at: now,
                auto_generated: 1
            });
            ncCount++;
        }
        const nc = db.insertRow('non_compliance_item', {
            drill_plan_id: planId,
            category: 'alarm_count',
            description: `演练期间共产生 ${alarms.length} 条告警，需分析根因`,
            severity: alarms.length >= 3 ? 'high' : 'medium',
            status: 'open',
            found_by: 'system',
            found_at: now,
            auto_generated: 1
        });
        ncCount++;
        const todo = db.insertRow('review_todo', {
            drill_plan_id: planId,
            content: '复盘演练期间所有告警，制定整改措施',
            assignee: '安全经理',
            priority: alarms.length >= 3 ? 'high' : 'medium',
            status: 'pending',
            created_by: 'system',
            created_at: now,
            auto_generated: 1
        });
        todoCount++;
    }

    if (loadRecords.length >= 2 && recovery) {
        const firstSwitch = loadRecords[0];
        const recoveryTime = new Date(recovery.recovery_time).getTime();
        const firstSwitchTime = new Date(firstSwitch.switch_time).getTime();
        const durationMin = Math.round((recoveryTime - firstSwitchTime) / 60000);

        if (durationMin > switchTimeTargetMin * 2) {
            const nc = db.insertRow('non_compliance_item', {
                drill_plan_id: planId,
                category: 'switch_duration',
                description: `切换总时长 ${durationMin} 分钟，超过目标值 ${switchTimeTargetMin} 分钟的2倍`,
                severity: 'high',
                status: 'open',
                found_by: 'system',
                found_at: now,
                auto_generated: 1
            });
            ncCount++;
        } else if (durationMin > switchTimeTargetMin) {
            const nc = db.insertRow('non_compliance_item', {
                drill_plan_id: planId,
                category: 'switch_duration',
                description: `切换总时长 ${durationMin} 分钟，超过目标值 ${switchTimeTargetMin} 分钟`,
                severity: 'medium',
                status: 'open',
                found_by: 'system',
                found_at: now,
                auto_generated: 1
            });
            ncCount++;
        }

        const todo = db.insertRow('review_todo', {
            drill_plan_id: planId,
            content: `优化切换流程，目标将切换时间控制在 ${switchTimeTargetMin} 分钟以内`,
            assignee: '运维值班员',
            priority: durationMin > switchTimeTargetMin ? 'high' : 'medium',
            status: 'pending',
            created_by: 'system',
            created_at: now,
            auto_generated: 1
        });
        todoCount++;
    }

    if (loadRecords.length === 0) {
        const nc = db.insertRow('non_compliance_item', {
            drill_plan_id: planId,
            category: 'missing_record',
            description: '演练缺少负载切换记录',
            severity: 'high',
            status: 'open',
            found_by: 'system',
            found_at: now,
            auto_generated: 1
        });
        ncCount++;
    }

    if (fuelRecords.length === 0) {
        const nc = db.insertRow('non_compliance_item', {
            drill_plan_id: planId,
            category: 'missing_record',
            description: '演练缺少油位记录',
            severity: 'medium',
            status: 'open',
            found_by: 'system',
            found_at: now,
            auto_generated: 1
        });
        ncCount++;
    }

    const todo = db.insertRow('review_todo', {
        drill_plan_id: planId,
        content: '组织演练复盘会议，总结经验教训',
        assignee: '安全经理',
        priority: 'medium',
        status: 'pending',
        created_by: 'system',
        created_at: now,
        auto_generated: 1
    });
    todoCount++;

    const todo2 = db.insertRow('review_todo', {
        drill_plan_id: planId,
        content: '更新演练预案和操作手册',
        assignee: '设施工程师',
        priority: 'medium',
        status: 'pending',
        created_by: 'system',
        created_at: now,
        auto_generated: 1
    });
    todoCount++;

    return { nonComplianceCount: ncCount, todoCount, autoGenerated: true };
}

app.post('/api/drill-plans/:id/complete', (req, res) => {
    const role = req.headers['x-user-role'] || ROLES.DUTY_OPERATOR;
    if (role !== ROLES.DUTY_OPERATOR && role !== ROLES.SAFETY_MANAGER) {
        return res.status(403).json({ error: '只有运维值班员或安全经理可以完成演练' });
    }
    const pid = parseInt(req.params.id);
    const plan = db.findById('drill_plan', pid);
    if (!plan) {
        return res.status(404).json({ error: '演练计划不存在' });
    }
    if (plan.status !== DRILL_STATUS.RECOVERY_CONFIRMED) {
        return res.status(400).json({ error: '必须先确认市电恢复才能完成演练' });
    }
    db.updateRows('drill_plan', p => p.id === pid, { status: DRILL_STATUS.COMPLETED, completed_at: new Date().toISOString() });
    const result = generateNonComplianceAndTodos(pid);
    res.json({
        id: pid,
        status: DRILL_STATUS.COMPLETED,
        auto_generated: result.autoGenerated,
        non_compliance_count: result.nonComplianceCount,
        review_todo_count: result.todoCount,
        message: '演练已完成，已自动生成未达标项和复盘待办'
    });
});

app.post('/api/drill-plans/:id/cancel', (req, res) => {
    const role = req.headers['x-user-role'] || ROLES.DUTY_OPERATOR;
    const { reason } = req.body;
    if (role !== ROLES.DUTY_OPERATOR && role !== ROLES.SAFETY_MANAGER) {
        return res.status(403).json({ error: '只有运维值班员或安全经理可以取消演练' });
    }
    const pid = parseInt(req.params.id);
    const plan = db.findById('drill_plan', pid);
    if (!plan) {
        return res.status(404).json({ error: '演练计划不存在' });
    }
    if (plan.status === DRILL_STATUS.COMPLETED) {
        return res.status(400).json({ error: '已完成的演练不能取消' });
    }
    const updates = { status: DRILL_STATUS.CANCELLED };
    if (reason) updates.remarks = reason;
    db.updateRows('drill_plan', p => p.id === pid, updates);
    res.json({ id: pid, status: DRILL_STATUS.CANCELLED, message: '演练已取消' });
});

app.get('/api/drill-summary/:id', (req, res) => {
    const pid = parseInt(req.params.id);
    const plan = db.findById('drill_plan', pid);
    if (!plan) {
        return res.status(404).json({ error: '演练计划不存在' });
    }
    const unit = db.findById('generator_unit', plan.unit_id);
    const loadRecords = db.listAll('load_switch_record', r => r.drill_plan_id === pid).sort((a, b) => a.id - b.id);
    const fuelRecords = db.listAll('fuel_level_record', r => r.drill_plan_id === pid).sort((a, b) => a.id - b.id);
    const recoveryRecord = db.findOne('recovery_record', r => r.drill_plan_id === pid);
    const alarms = db.listAll('alarm_record', a => a.drill_plan_id === pid).sort((a, b) => a.id - b.id);
    const nonComplianceItems = db.listAll('non_compliance_item', i => i.drill_plan_id === pid).sort((a, b) => a.id - b.id);
    const reviewTodos = db.listAll('review_todo', t => t.drill_plan_id === pid).sort((a, b) => a.id - b.id);
    const loadCurvePoints = db.listAll('load_curve_point', p => p.drill_plan_id === pid).sort((a, b) => a.id - b.id);
    const fuelThreshold = db.getConfig('fuel_level_threshold') || 20;
    const upsThreshold = db.getConfig('ups_margin_threshold') || 30;
    const switchTimeTargetMin = db.getConfig('switch_time_target_min') || 5;
    const loadDeviationThreshold = db.getConfig('load_deviation_threshold') || 10;
    const statusMap = {
        [DRILL_STATUS.PENDING]: '待开始',
        [DRILL_STATUS.IN_PROGRESS]: '进行中',
        [DRILL_STATUS.LOAD_SWITCHED]: '已切换负载',
        [DRILL_STATUS.RECOVERY_CONFIRMED]: '已确认恢复',
        [DRILL_STATUS.COMPLETED]: '已完成',
        [DRILL_STATUS.CANCELLED]: '已取消'
    };
    const unitLocked = db.isUnitLockedByDrill(plan.unit_id);
    const summary = {
        plan: {
            id: plan.id, plan_code: plan.plan_code, plan_name: plan.plan_name,
            status: plan.status, status_name: statusMap[plan.status] || plan.status,
            initiator: plan.initiator, initiator_role_name: getRoleName(plan.initiator_role),
            planned_start_time: plan.planned_start_time, actual_start_time: plan.actual_start_time,
            actual_end_time: plan.actual_end_time, completed_at: plan.completed_at,
            ups_margin_percent: plan.ups_margin_percent,
            ups_margin_ok: plan.ups_margin_percent >= upsThreshold, remarks: plan.remarks
        },
        generator_unit: {
            id: plan.unit_id, unit_code: unit?.unit_code, unit_name: unit?.unit_name,
            capacity_kw: unit?.capacity_kw, fuel_tank_capacity_l: unit?.fuel_tank_capacity_l,
            status: unit?.status, is_locked: unitLocked
        },
        load_switch_records: loadRecords.map(r => ({
            id: r.id, switch_type: r.switch_type, load_kw: r.load_kw,
            switch_time: r.switch_time, recorded_by: r.recorded_by, is_locked: r.is_locked === 1
        })),
        fuel_level_records: fuelRecords.map(r => ({
            id: r.id, fuel_level_l: r.fuel_level_l, fuel_level_percent: r.fuel_level_percent,
            below_threshold: r.below_threshold === 1, threshold_percent: fuelThreshold,
            recorded_by: r.recorded_by, recorded_at: r.recorded_at
        })),
        recovery_record: recoveryRecord ? {
            recovery_time: recoveryRecord.recovery_time, confirmed_by: recoveryRecord.confirmed_by,
            confirmed_at: recoveryRecord.confirmed_at, utility_power_restored: recoveryRecord.utility_power_restored === 1
        } : null,
        alarms: alarms.map(a => ({
            id: a.id, alarm_type: a.alarm_type, alarm_level: a.alarm_level,
            description: a.description, handled: a.handled === 1,
            handled_by: a.handled_by, handled_at: a.handled_at,
            handle_remark: a.handle_remark, reported_by: a.reported_by, reported_at: a.reported_at
        })),
        non_compliance_items: nonComplianceItems.map(i => ({
            id: i.id, category: i.category, description: i.description,
            severity: i.severity, status: i.status,
            found_by: i.found_by, found_at: i.found_at,
            rectification_measure: i.rectification_measure,
            closed_by: i.closed_by, closed_at: i.closed_at,
            auto_generated: i.auto_generated === 1
        })),
        review_todos: reviewTodos.map(t => ({
            id: t.id, content: t.content, assignee: t.assignee,
            priority: t.priority, due_date: t.due_date,
            status: t.status, created_by: t.created_by, created_at: t.created_at,
            completed_by: t.completed_by, completed_at: t.completed_at,
            completion_remark: t.completion_remark, auto_generated: t.auto_generated === 1
        })),
        load_curve_points: loadCurvePoints.map(p => ({
            id: p.id, point_index: p.point_index,
            timestamp: p.timestamp, load_kw: p.load_kw
        })),
        thresholds: {
            ups_margin_threshold: upsThreshold,
            fuel_level_threshold: fuelThreshold,
            switch_time_target_min: switchTimeTargetMin,
            load_deviation_threshold: loadDeviationThreshold
        },
        stats: {
            alarm_count: alarms.length,
            unhandled_alarm_count: alarms.filter(a => a.handled === 0).length,
            non_compliance_count: nonComplianceItems.length,
            open_non_compliance_count: nonComplianceItems.filter(i => i.status === 'open').length,
            review_todo_count: reviewTodos.length,
            pending_todo_count: reviewTodos.filter(t => t.status === 'pending').length
        },
        can_edit_load_switch: !recoveryRecord && plan.status !== DRILL_STATUS.COMPLETED && plan.status !== DRILL_STATUS.CANCELLED,
        can_complete: plan.status === DRILL_STATUS.RECOVERY_CONFIRMED
    };
    res.json(summary);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`数据中心柴油发电机演练系统 API 服务已启动: http://0.0.0.0:${PORT}`);
    console.log(`静态页面服务: http://0.0.0.0:${PORT}`);
});

module.exports = app;
