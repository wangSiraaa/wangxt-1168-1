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
    const { switch_type, load_kw, switch_time, recorded_by } = req.body;
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
    db.updateRows('drill_plan', p => p.id === pid && p.status === DRILL_STATUS.IN_PROGRESS, { status: DRILL_STATUS.LOAD_SWITCHED });
    res.json({ id: r.id, message: '负载切换记录已保存' });
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
    db.updateRows('drill_plan', p => p.id === pid, { status: DRILL_STATUS.COMPLETED });
    res.json({ id: pid, status: DRILL_STATUS.COMPLETED, message: '演练已完成' });
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
    const fuelThreshold = db.getConfig('fuel_level_threshold') || 20;
    const upsThreshold = db.getConfig('ups_margin_threshold') || 30;
    const statusMap = {
        [DRILL_STATUS.PENDING]: '待开始',
        [DRILL_STATUS.IN_PROGRESS]: '进行中',
        [DRILL_STATUS.LOAD_SWITCHED]: '已切换负载',
        [DRILL_STATUS.RECOVERY_CONFIRMED]: '已确认恢复',
        [DRILL_STATUS.COMPLETED]: '已完成',
        [DRILL_STATUS.CANCELLED]: '已取消'
    };
    const summary = {
        plan: {
            id: plan.id, plan_code: plan.plan_code, plan_name: plan.plan_name,
            status: plan.status, status_name: statusMap[plan.status] || plan.status,
            initiator: plan.initiator, initiator_role_name: getRoleName(plan.initiator_role),
            planned_start_time: plan.planned_start_time, actual_start_time: plan.actual_start_time,
            actual_end_time: plan.actual_end_time, ups_margin_percent: plan.ups_margin_percent,
            ups_margin_ok: plan.ups_margin_percent >= upsThreshold, remarks: plan.remarks
        },
        generator_unit: {
            id: plan.unit_id, unit_code: unit?.unit_code, unit_name: unit?.unit_name,
            capacity_kw: unit?.capacity_kw, fuel_tank_capacity_l: unit?.fuel_tank_capacity_l
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
        thresholds: { ups_margin_threshold: upsThreshold, fuel_level_threshold: fuelThreshold },
        can_edit_load_switch: !recoveryRecord && plan.status !== DRILL_STATUS.COMPLETED && plan.status !== DRILL_STATUS.CANCELLED
    };
    res.json(summary);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`数据中心柴油发电机演练系统 API 服务已启动: http://0.0.0.0:${PORT}`);
    console.log(`静态页面服务: http://0.0.0.0:${PORT}`);
});

module.exports = app;
