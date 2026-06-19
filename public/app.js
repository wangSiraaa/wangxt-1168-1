const API_BASE = '/api';

let currentRole = 'duty_operator';
let currentUser = '张工';
let unitsCache = [];
let configCache = [];

const statusNames = {
    pending: '待开始',
    in_progress: '进行中',
    load_switched: '已切换负载',
    recovery_confirmed: '已确认恢复',
    completed: '已完成',
    cancelled: '已取消'
};

const roleNames = {
    duty_operator: '运维值班员',
    facility_engineer: '设施工程师',
    safety_manager: '安全经理'
};

function getHeaders() {
    return {
        'Content-Type': 'application/json',
        'X-User-Role': currentRole
    };
}

async function apiGet(url) {
    const res = await fetch(API_BASE + url, { headers: getHeaders() });
    return res.json();
}

async function apiPost(url, data) {
    const res = await fetch(API_BASE + url, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(data || {})
    });
    const json = await res.json();
    if (!res.ok && json.error) {
        alert(json.error);
        throw new Error(json.error);
    }
    return json;
}

async function apiPut(url, data) {
    const res = await fetch(API_BASE + url, {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify(data || {})
    });
    const json = await res.json();
    if (!res.ok && json.error) {
        alert(json.error);
        throw new Error(json.error);
    }
    return json;
}

function showModal(title, bodyHtml, footerHtml) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = bodyHtml;
    document.getElementById('modalFooter').innerHTML = footerHtml || '';
    document.getElementById('modal').classList.add('active');
}

function closeModal() {
    document.getElementById('modal').classList.remove('active');
}

function formatDateTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { hour12: false });
}

function nowLocalISO() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function switchView(viewName) {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === viewName);
    });
    document.querySelectorAll('.view').forEach(v => {
        v.classList.toggle('active', v.id === `view-${viewName}`);
    });
    if (viewName === 'plans') loadPlans();
    if (viewName === 'units') loadUnits();
    if (viewName === 'config') loadConfig();
}

async function loadPlans() {
    const data = await apiGet('/drill-plans');
    const container = document.getElementById('planList');
    
    if (!data.plans || data.plans.length === 0) {
        container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📋</div><p>暂无演练计划，点击右上角按钮新建</p></div>`;
        return;
    }
    
    container.innerHTML = data.plans.map(plan => renderPlanCard(plan)).join('');
}

function renderPlanCard(plan) {
    const actions = getPlanActions(plan);
    return `
        <div class="plan-card" onclick="openPlanDetail(${plan.id})">
            <div class="plan-card-header">
                <div>
                    <div class="plan-card-title">${plan.plan_name}</div>
                    <div class="plan-card-code">${plan.plan_code} · 发起人：${plan.initiator}</div>
                </div>
                <span class="status-badge status-${plan.status}">${statusNames[plan.status] || plan.status}</span>
            </div>
            <div class="plan-card-info">
                <div><span>机组：</span>${plan.unit_name} (${plan.unit_code})</div>
                <div><span>机组状态：</span><span class="unit-status unit-status-${plan.unit_status}">${plan.unit_status === 'normal' ? '正常' : '维护中'}</span></div>
                <div><span>UPS余量：</span>${plan.ups_margin_percent != null ? plan.ups_margin_percent + '%' : '-'}</div>
                <div><span>计划开始：</span>${formatDateTime(plan.planned_start_time)}</div>
                <div><span>实际开始：</span>${formatDateTime(plan.actual_start_time)}</div>
                <div><span>负载记录：</span>${plan.load_record_count || 0} 条</div>
                <div><span>油位记录：</span>${plan.fuel_record_count || 0} 条</div>
                <div><span>告警：</span>${plan.alarm_count || 0} 条</div>
                <div><span>市电恢复：</span>${plan.recovery_confirmed ? '已确认' : '未确认'}</div>
            </div>
            ${plan.status === 'completed' ? `
            <div class="plan-card-stats">
                <div class="plan-stat">
                    <span class="plan-stat-label">未达标</span>
                    <span class="plan-stat-value stat-danger">${plan.non_compliance_count || 0}</span>
                </div>
                <div class="plan-stat">
                    <span class="plan-stat-label">待办</span>
                    <span class="plan-stat-value stat-info">${plan.review_todo_count || 0}</span>
                </div>
            </div>
            ` : ''}
            <div class="plan-card-actions" onclick="event.stopPropagation()">
                ${actions.map(a => `<button class="${a.cls}" onclick="${a.handler}">${a.label}</button>`).join('')}
            </div>
        </div>
    `;
}

function getPlanActions(plan) {
    const actions = [];
    if (currentRole === 'duty_operator') {
        if (plan.status === 'pending') {
            actions.push({ label: '开始演练', cls: 'btn-success btn-sm', handler: `startDrill(${plan.id})` });
            actions.push({ label: '取消', cls: 'btn-danger btn-sm', handler: `cancelDrill(${plan.id})` });
        }
        if (plan.status === 'recovery_confirmed') {
            actions.push({ label: '完成演练', cls: 'btn-primary btn-sm', handler: `completeDrill(${plan.id})` });
        }
    }
    if (currentRole === 'facility_engineer' && (plan.status === 'in_progress' || plan.status === 'load_switched')) {
        actions.push({ label: '记录负载', cls: 'btn-warning btn-sm', handler: `openLoadSwitchForm(${plan.id})` });
        actions.push({ label: '记录油位', cls: 'btn-warning btn-sm', handler: `openFuelLevelForm(${plan.id})` });
    }
    if (currentRole === 'safety_manager' && (plan.status === 'in_progress' || plan.status === 'load_switched')) {
        actions.push({ label: '确认恢复', cls: 'btn-success btn-sm', handler: `openRecoveryConfirm(${plan.id})` });
    }
    return actions;
}

function openCreatePlanForm() {
    if (currentRole !== 'duty_operator') {
        alert('只有运维值班员可以创建演练计划');
        return;
    }
    const unitOptions = unitsCache.filter(u => u.status === 'normal')
        .map(u => `<option value="${u.id}">${u.unit_name} (${u.unit_code})</option>`).join('');
    
    showModal('新建演练计划', `
        <div class="form-group">
            <label class="required">演练计划名称</label>
            <input type="text" id="planName" placeholder="例：2024年Q2柴油发电机切换演练">
        </div>
        <div class="form-row">
            <div class="form-group">
                <label class="required">机组</label>
                <select id="planUnitId">${unitOptions}</select>
            </div>
            <div class="form-group">
                <label>计划开始时间</label>
                <input type="datetime-local" id="planStartTime" value="${nowLocalISO()}">
            </div>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label class="required">UPS余量 (%)</label>
                <input type="number" id="planUpsMargin" value="50" min="0" max="100">
            </div>
            <div class="form-group">
                <label>发起人</label>
                <input type="text" id="planInitiator" value="${currentUser}">
            </div>
        </div>
        <div class="form-group">
            <label>备注</label>
            <textarea id="planRemarks" rows="2" placeholder="可选"></textarea>
        </div>
    `, `
        <button class="btn-secondary" onclick="closeModal()">取消</button>
        <button class="btn-primary" onclick="submitCreatePlan()">确认创建</button>
    `);
}

async function submitCreatePlan() {
    const plan_name = document.getElementById('planName').value.trim();
    const unit_id = parseInt(document.getElementById('planUnitId').value);
    const planned_start_time = document.getElementById('planStartTime').value ? 
        new Date(document.getElementById('planStartTime').value).toISOString() : null;
    const ups_margin_percent = parseInt(document.getElementById('planUpsMargin').value);
    const initiator = document.getElementById('planInitiator').value.trim() || currentUser;
    const remarks = document.getElementById('planRemarks').value.trim();

    if (!plan_name || !unit_id) {
        alert('请填写必要信息');
        return;
    }

    try {
        await apiPost('/drill-plans', {
            plan_name, unit_id, planned_start_time, ups_margin_percent, initiator, remarks
        });
        closeModal();
        loadPlans();
        alert('演练计划创建成功');
    } catch (e) {}
}

async function startDrill(id) {
    try {
        await apiPost(`/drill-plans/${id}/start`, {});
        loadPlans();
        alert('演练已开始');
    } catch (e) {}
}

async function cancelDrill(id) {
    if (!confirm('确定要取消此演练计划吗？')) return;
    try {
        await apiPost(`/drill-plans/${id}/cancel`, { reason: '用户取消' });
        loadPlans();
    } catch (e) {}
}

async function completeDrill(id) {
    if (!confirm('确定要完成此演练吗？')) return;
    try {
        await apiPost(`/drill-plans/${id}/complete`, {});
        loadPlans();
        alert('演练已完成');
    } catch (e) {}
}

function getSeverityTag(severity) {
    const map = {
        high: '<span class="tag-danger">高</span>',
        medium: '<span class="tag-warning">中</span>',
        low: '<span class="tag-info">低</span>'
    };
    return map[severity] || severity;
}

function getPriorityTag(priority) {
    const map = {
        high: '<span class="tag-danger">高</span>',
        medium: '<span class="tag-warning">中</span>',
        low: '<span class="tag-info">低</span>'
    };
    return map[priority] || priority;
}

function getAlarmLevelTag(level) {
    const map = {
        info: '<span class="tag-info">提示</span>',
        warning: '<span class="tag-warning">警告</span>',
        danger: '<span class="tag-danger">严重</span>'
    };
    return map[level] || level;
}

async function openPlanDetail(id) {
    const summary = await apiGet(`/drill-summary/${id}`);
    const p = summary.plan;
    const u = summary.generator_unit;
    const stats = summary.stats || {};

    let html = `
        <div class="detail-section">
            <h4>基本信息</h4>
            <div class="detail-grid">
                <div><span>计划编号：</span>${p.plan_code}</div>
                <div><span>计划名称：</span>${p.plan_name}</div>
                <div><span>状态：</span><span class="status-badge status-${p.status}">${p.status_name}</span></div>
                <div><span>发起人：</span>${p.initiator} (${p.initiator_role_name})</div>
                <div><span>计划开始：</span>${formatDateTime(p.planned_start_time)}</div>
                <div><span>实际开始：</span>${formatDateTime(p.actual_start_time)}</div>
                <div><span>结束时间：</span>${formatDateTime(p.actual_end_time)}</div>
                <div><span>完成时间：</span>${formatDateTime(p.completed_at)}</div>
                <div><span>UPS余量：</span>${p.ups_margin_percent != null ? p.ups_margin_percent + '% ' + (p.ups_margin_ok ? '✓' : '✗ 不足') : '-'}</div>
            </div>
            ${p.remarks ? `<div style="margin-top:8px;"><span style="color:#6b7280;">备注：</span>${p.remarks}</div>` : ''}
        </div>

        <div class="detail-section">
            <h4>机组信息</h4>
            <div class="detail-grid">
                <div><span>机组编号：</span>${u.unit_code}</div>
                <div><span>机组名称：</span>${u.unit_name}</div>
                <div><span>容量：</span>${u.capacity_kw} kW</div>
                <div><span>油箱容量：</span>${u.fuel_tank_capacity_l} L</div>
                <div><span>机组状态：</span><span class="unit-status unit-status-${u.status}">${u.status === 'normal' ? '正常' : '维护中'}</span></div>
                <div><span>演练锁定：</span>${u.is_locked ? '<span class="tag-warning">演练中已锁定</span>' : '<span class="tag-success">未锁定</span>'}</div>
            </div>
        </div>

        ${p.status === 'completed' ? `
        <div class="detail-section">
            <h4>统计概览</h4>
            <div class="stat-grid">
                <div class="stat-card">
                    <div class="stat-label">告警总数</div>
                    <div class="stat-value">${stats.alarm_count || 0}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">未处理告警</div>
                    <div class="stat-value stat-warning">${stats.unhandled_alarm_count || 0}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">未达标项</div>
                    <div class="stat-value stat-danger">${stats.non_compliance_count || 0}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">复盘待办</div>
                    <div class="stat-value stat-info">${stats.review_todo_count || 0}</div>
                </div>
            </div>
        </div>
        ` : ''}
    `;

    if (summary.load_switch_records.length > 0) {
        html += `
            <div class="detail-section">
                <h4>负载切换记录 (${summary.load_switch_records.length})</h4>
                <table class="record-table">
                    <thead><tr><th>切换类型</th><th>负载 (kW)</th><th>切换时间</th><th>记录人</th><th>状态</th></tr></thead>
                    <tbody>
                        ${summary.load_switch_records.map(r => `
                            <tr>
                                <td>${r.switch_type}</td>
                                <td>${r.load_kw}</td>
                                <td>${formatDateTime(r.switch_time)}</td>
                                <td>${r.recorded_by}</td>
                                <td>${r.is_locked ? '<span class="tag-info">已锁定</span>' : '<span class="tag-success">可编辑</span>'}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    if (summary.fuel_level_records.length > 0) {
        html += `
            <div class="detail-section">
                <h4>油位记录 (${summary.fuel_level_records.length})</h4>
                <table class="record-table">
                    <thead><tr><th>油位 (L)</th><th>油位 (%)</th><th>阈值</th><th>状态</th><th>记录人</th><th>记录时间</th></tr></thead>
                    <tbody>
                        ${summary.fuel_level_records.map(r => `
                            <tr>
                                <td>${r.fuel_level_l}</td>
                                <td>${r.fuel_level_percent}%</td>
                                <td>${r.threshold_percent}%</td>
                                <td>${r.below_threshold ? '<span class="tag-danger">低于阈值 请补油</span>' : '<span class="tag-success">正常</span>'}</td>
                                <td>${r.recorded_by}</td>
                                <td>${formatDateTime(r.recorded_at)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    if (summary.alarms && summary.alarms.length > 0) {
        html += `
            <div class="detail-section">
                <h4>告警记录 (${summary.alarms.length})</h4>
                <table class="record-table">
                    <thead><tr><th>类型</th><th>级别</th><th>描述</th><th>状态</th><th>报告人</th><th>时间</th></tr></thead>
                    <tbody>
                        ${summary.alarms.map(a => `
                            <tr>
                                <td>${a.alarm_type}</td>
                                <td>${getAlarmLevelTag(a.alarm_level)}</td>
                                <td>${a.description}</td>
                                <td>${a.handled ? '<span class="tag-success">已处理</span>' : '<span class="tag-warning">未处理</span>'}</td>
                                <td>${a.reported_by}</td>
                                <td>${formatDateTime(a.reported_at)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    if (summary.load_curve_points && summary.load_curve_points.length > 0) {
        html += `
            <div class="detail-section">
                <h4>负载曲线数据 (${summary.load_curve_points.length} 点)</h4>
                <table class="record-table">
                    <thead><tr><th>序号</th><th>时间</th><th>负载 (kW)</th></tr></thead>
                    <tbody>
                        ${summary.load_curve_points.map((p, i) => `
                            <tr>
                                <td>${i + 1}</td>
                                <td>${formatDateTime(p.timestamp)}</td>
                                <td>${p.load_kw}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    if (summary.recovery_record) {
        const rec = summary.recovery_record;
        html += `
            <div class="detail-section">
                <h4>市电恢复确认</h4>
                <div class="detail-grid">
                    <div><span>恢复时间：</span>${formatDateTime(rec.recovery_time)}</div>
                    <div><span>确认人：</span>${rec.confirmed_by}</div>
                    <div><span>确认时间：</span>${formatDateTime(rec.confirmed_at)}</div>
                    <div><span>市电状态：</span><span class="tag-success">已恢复</span></div>
                </div>
                <div style="margin-top:10px;" class="alert alert-info">
                    ⚠️ 市电恢复已确认，所有负载切换时间和机组状态已锁定，不可修改。
                </div>
            </div>
        `;
    }

    if (summary.non_compliance_items && summary.non_compliance_items.length > 0) {
        html += `
            <div class="detail-section">
                <h4>未达标项 (${summary.non_compliance_items.length})</h4>
                <div class="nc-list">
                    ${summary.non_compliance_items.map(item => `
                        <div class="nc-item">
                            <div class="nc-item-header">
                                <span class="nc-category">${item.category}</span>
                                ${getSeverityTag(item.severity)}
                                ${item.auto_generated ? '<span class="tag-info">系统生成</span>' : ''}
                                <span class="tag-${item.status === 'open' ? 'warning' : 'success'}">${item.status === 'open' ? '待整改' : '已关闭'}</span>
                            </div>
                            <div class="nc-item-desc">${item.description}</div>
                            <div class="nc-item-meta">
                                <span>发现人：${item.found_by || '-'}</span>
                                <span>发现时间：${formatDateTime(item.found_at)}</span>
                            </div>
                            ${item.rectification_measure ? `<div class="nc-item-measure"><strong>整改措施：</strong>${item.rectification_measure}</div>` : ''}
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    if (summary.review_todos && summary.review_todos.length > 0) {
        html += `
            <div class="detail-section">
                <h4>复盘待办 (${summary.review_todos.length})</h4>
                <div class="todo-list">
                    ${summary.review_todos.map(todo => `
                        <div class="todo-item">
                            <div class="todo-item-header">
                                <span class="todo-status todo-${todo.status}">${todo.status === 'pending' ? '待处理' : todo.status === 'completed' ? '已完成' : todo.status}</span>
                                ${getPriorityTag(todo.priority)}
                                ${todo.auto_generated ? '<span class="tag-info">系统生成</span>' : ''}
                            </div>
                            <div class="todo-item-content">${todo.content}</div>
                            <div class="todo-item-meta">
                                <span>负责人：${todo.assignee || '-'}</span>
                                <span>创建人：${todo.created_by || '-'}</span>
                                <span>创建时间：${formatDateTime(todo.created_at)}</span>
                            </div>
                            ${todo.completed_at ? `<div class="todo-item-completed"><strong>完成时间：</strong>${formatDateTime(todo.completed_at)}，完成人：${todo.completed_by || '-'}</div>` : ''}
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    const actions = getPlanActions(summary.plan);
    let footer = '';
    if (actions.length > 0) {
        footer = actions.map(a => `<button class="${a.cls}" onclick="closeModal(); ${a.handler}">${a.label}</button>`).join(' ');
    }
    footer += `<button class="btn-secondary" onclick="closeModal()">关闭</button>`;

    showModal('演练详情 - ' + p.plan_name, html, footer);
}

let tempAlarms = [];
let tempCurvePoints = [];

function openLoadSwitchForm(planId) {
    tempAlarms = [];
    tempCurvePoints = [];
    showModal('记录负载切换', `
        <div class="alert alert-info">💡 市电恢复确认后，负载切换时间将被锁定，无法修改</div>
        <div class="form-group">
            <label class="required">切换类型</label>
            <select id="switchType">
                <option value="市电转发电机">市电转发电机</option>
                <option value="发电机转市电">发电机转市电</option>
                <option value="部分负载切换">部分负载切换</option>
                <option value="全负载切换">全负载切换</option>
            </select>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label class="required">负载 (kW)</label>
                <input type="number" id="switchLoad" value="600" min="0">
            </div>
            <div class="form-group">
                <label class="required">切换时间</label>
                <input type="datetime-local" id="switchTime" value="${nowLocalISO()}">
            </div>
        </div>
        <div class="form-group">
            <label class="required">记录人</label>
            <input type="text" id="switchRecorder" value="${currentUser}">
        </div>
        <div class="form-divider"></div>
        <div class="form-group">
            <label>油位 (L) <span style="color:#9ca3af;font-size:12px;">（可选，与切换记录关联保存）</span></label>
            <input type="number" id="switchFuelLevel" value="" min="0" placeholder="请输入油位，留空则不记录">
        </div>
        <div class="form-divider"></div>
        <div class="form-group">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <label style="margin:0;">告警信息 <span style="color:#9ca3af;font-size:12px;">（可选）</span></label>
                <button class="btn-sm btn-secondary" onclick="addTempAlarm()">+ 添加告警</button>
            </div>
            <div id="tempAlarmsList" class="temp-list">
                <div class="empty-inline">暂无告警，点击上方按钮添加</div>
            </div>
        </div>
        <div class="form-divider"></div>
        <div class="form-group">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <label style="margin:0;">负载曲线数据点 <span style="color:#9ca3af;font-size:12px;">（可选）</span></label>
                <button class="btn-sm btn-secondary" onclick="addTempCurvePoint()">+ 添加数据点</button>
            </div>
            <div id="tempCurveList" class="temp-list">
                <div class="empty-inline">暂无数据点，点击上方按钮添加</div>
            </div>
        </div>
    `, `
        <button class="btn-secondary" onclick="closeModal()">取消</button>
        <button class="btn-primary" onclick="submitLoadSwitch(${planId})">保存记录</button>
    `);
}

function addTempAlarm() {
    const id = Date.now();
    tempAlarms.push({
        id, alarm_type: 'general', alarm_level: 'warning', description: ''
    });
    renderTempAlarms();
}

function removeTempAlarm(id) {
    tempAlarms = tempAlarms.filter(a => a.id !== id);
    renderTempAlarms();
}

function updateTempAlarm(id, field, value) {
    const alarm = tempAlarms.find(a => a.id === id);
    if (alarm) alarm[field] = value;
}

function renderTempAlarms() {
    const container = document.getElementById('tempAlarmsList');
    if (!container) return;
    if (tempAlarms.length === 0) {
        container.innerHTML = '<div class="empty-inline">暂无告警，点击上方按钮添加</div>';
        return;
    }
    container.innerHTML = tempAlarms.map((a, idx) => `
        <div class="temp-item">
            <div class="temp-item-header">
                <span>告警 #${idx + 1}</span>
                <button class="btn-sm btn-danger" onclick="removeTempAlarm(${a.id})">删除</button>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>类型</label>
                    <select onchange="updateTempAlarm(${a.id}, 'alarm_type', this.value)">
                        <option value="general" ${a.alarm_type === 'general' ? 'selected' : ''}>一般告警</option>
                        <option value="overload" ${a.alarm_type === 'overload' ? 'selected' : ''}>过载告警</option>
                        <option value="fuel" ${a.alarm_type === 'fuel' ? 'selected' : ''}>油位告警</option>
                        <option value="temperature" ${a.alarm_type === 'temperature' ? 'selected' : ''}>温度告警</option>
                        <option value="voltage" ${a.alarm_type === 'voltage' ? 'selected' : ''}>电压告警</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>级别</label>
                    <select onchange="updateTempAlarm(${a.id}, 'alarm_level', this.value)">
                        <option value="info" ${a.alarm_level === 'info' ? 'selected' : ''}>提示</option>
                        <option value="warning" ${a.alarm_level === 'warning' ? 'selected' : ''}>警告</option>
                        <option value="danger" ${a.alarm_level === 'danger' ? 'selected' : ''}>严重</option>
                    </select>
                </div>
            </div>
            <div class="form-group">
                <label>描述</label>
                <input type="text" placeholder="请输入告警描述" value="${a.description}" onchange="updateTempAlarm(${a.id}, 'description', this.value)">
            </div>
        </div>
    `).join('');
}

function addTempCurvePoint() {
    const id = Date.now();
    const now = new Date();
    const timeStr = now.toISOString().slice(0, 16);
    tempCurvePoints.push({
        id, timestamp: timeStr, load_kw: 500
    });
    renderTempCurve();
}

function removeTempCurvePoint(id) {
    tempCurvePoints = tempCurvePoints.filter(p => p.id !== id);
    renderTempCurve();
}

function updateTempCurvePoint(id, field, value) {
    const point = tempCurvePoints.find(p => p.id === id);
    if (point) {
        if (field === 'load_kw') {
            point[field] = parseFloat(value) || 0;
        } else {
            point[field] = value;
        }
    }
}

function renderTempCurve() {
    const container = document.getElementById('tempCurveList');
    if (!container) return;
    if (tempCurvePoints.length === 0) {
        container.innerHTML = '<div class="empty-inline">暂无数据点，点击上方按钮添加</div>';
        return;
    }
    container.innerHTML = tempCurvePoints.map((p, idx) => `
        <div class="temp-item">
            <div class="temp-item-header">
                <span>数据点 #${idx + 1}</span>
                <button class="btn-sm btn-danger" onclick="removeTempCurvePoint(${p.id})">删除</button>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>时间</label>
                    <input type="datetime-local" value="${p.timestamp}" onchange="updateTempCurvePoint(${p.id}, 'timestamp', this.value)">
                </div>
                <div class="form-group">
                    <label>负载 (kW)</label>
                    <input type="number" value="${p.load_kw}" min="0" onchange="updateTempCurvePoint(${p.id}, 'load_kw', this.value)">
                </div>
            </div>
        </div>
    `).join('');
}

async function submitLoadSwitch(planId) {
    const switch_type = document.getElementById('switchType').value;
    const load_kw = parseInt(document.getElementById('switchLoad').value);
    const switch_time = new Date(document.getElementById('switchTime').value).toISOString();
    const recorded_by = document.getElementById('switchRecorder').value.trim() || currentUser;
    const fuelLevelInput = document.getElementById('switchFuelLevel');
    const fuel_level_l = fuelLevelInput && fuelLevelInput.value ? parseFloat(fuelLevelInput.value) : null;

    const alarms = tempAlarms.filter(a => a.description && a.description.trim()).map(a => ({
        alarm_type: a.alarm_type,
        alarm_level: a.alarm_level,
        description: a.description
    }));

    const load_curve = tempCurvePoints.map(p => ({
        timestamp: p.timestamp ? new Date(p.timestamp).toISOString(),
        load_kw: p.load_kw
    }));

    try {
        const result = await apiPost(`/drill-plans/${planId}/load-switch`, {
            switch_type, load_kw, switch_time, recorded_by,
            fuel_level_l, alarms, load_curve
        });
        closeModal();
        loadPlans();
        let msg = '负载切换记录已保存';
        if (result.alarm_count > 0) msg += `，已关联 ${result.alarm_count} 条告警`;
        if (result.curve_point_count > 0) msg += `，${result.curve_point_count} 个曲线点`;
        if (result.fuel_record) msg += '，油位已记录';
        alert(msg);
    } catch (e) {}
}

function openFuelLevelForm(planId) {
    const unit = unitsCache.find(u => true);
    const threshold = (configCache.find(c => c.config_key === 'fuel_level_threshold') || {}).config_value || 20;
    showModal('记录油位', `
        <div class="alert alert-warning">⚠️ 油位低于 ${threshold}% 将触发补油提示</div>
        <div class="form-row">
            <div class="form-group">
                <label class="required">油位 (L)</label>
                <input type="number" id="fuelLevel" value="4000" min="0">
            </div>
            <div class="form-group">
                <label class="required">记录人</label>
                <input type="text" id="fuelRecorder" value="${currentUser}">
            </div>
        </div>
    `, `
        <button class="btn-secondary" onclick="closeModal()">取消</button>
        <button class="btn-primary" onclick="submitFuelLevel(${planId})">保存记录</button>
    `);
}

async function submitFuelLevel(planId) {
    const fuel_level_l = parseInt(document.getElementById('fuelLevel').value);
    const recorded_by = document.getElementById('fuelRecorder').value.trim() || currentUser;
    
    try {
        const result = await apiPost(`/drill-plans/${planId}/fuel-level`, { fuel_level_l, recorded_by });
        closeModal();
        loadPlans();
        if (result.warning) {
            alert('⚠️ ' + result.warning);
        } else {
            alert('油位记录已保存');
        }
    } catch (e) {}
}

function openRecoveryConfirm(planId) {
    showModal('确认市电恢复', `
        <div class="alert alert-danger">
            ⚠️ 确认后将锁定所有负载切换记录，切换时间将无法修改！
        </div>
        <div class="form-row">
            <div class="form-group">
                <label class="required">恢复时间</label>
                <input type="datetime-local" id="recoveryTime" value="${nowLocalISO()}">
            </div>
            <div class="form-group">
                <label class="required">确认人</label>
                <input type="text" id="recoveryConfirmer" value="${currentUser}">
            </div>
        </div>
    `, `
        <button class="btn-secondary" onclick="closeModal()">取消</button>
        <button class="btn-success" onclick="submitRecoveryConfirm(${planId})">确认市电已恢复</button>
    `);
}

async function submitRecoveryConfirm(planId) {
    if (!confirm('确认市电已恢复？确认后负载切换时间将被锁定！')) return;
    
    const recovery_time = new Date(document.getElementById('recoveryTime').value).toISOString();
    const confirmed_by = document.getElementById('recoveryConfirmer').value.trim() || currentUser;
    
    try {
        await apiPost(`/drill-plans/${planId}/confirm-recovery`, { recovery_time, confirmed_by });
        closeModal();
        loadPlans();
        alert('市电恢复已确认，切换时间已锁定');
    } catch (e) {}
}

async function loadUnits() {
    const data = await apiGet('/generator-units');
    unitsCache = data.units || [];
    const container = document.getElementById('unitList');

    if (unitsCache.length === 0) {
        container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚡</div><p>暂无机组数据</p></div>`;
        return;
    }

    container.innerHTML = unitsCache.map(u => `
        <div class="unit-card">
            <div class="unit-card-header">
                <div>
                    <div class="unit-card-title">${u.unit_name}</div>
                    <div class="unit-card-code">${u.unit_code}</div>
                </div>
                <span class="unit-status unit-status-${u.status}">${u.status === 'normal' ? '正常' : '维护中'}</span>
            </div>
            <div class="unit-card-info">
                <div>额定容量：${u.capacity_kw} kW</div>
                <div>油箱容量：${u.fuel_tank_capacity_l} L</div>
                <div>创建时间：${formatDateTime(u.created_at)}</div>
            </div>
            <div class="unit-card-actions">
                ${currentRole === 'facility_engineer' || currentRole === 'safety_manager' ? `
                    <button class="btn-sm btn-secondary" onclick="checkAndToggleUnitStatus(${u.id}, '${u.status}')">
                        ${u.status === 'normal' ? '设为维护中' : '设为正常'}
                    </button>
                ` : ''}
            </div>
        </div>
    `).join('');
}

async function checkAndToggleUnitStatus(unitId, currentStatus) {
    try {
        const lockRes = await apiGet(`/generator-units/${unitId}/lock-status`);
        if (lockRes.locked) {
            alert('该机组正在进行演练，状态已锁定，不能修改！');
            return;
        }
        const newStatus = currentStatus === 'normal' ? 'maintenance' : 'normal';
        if (!confirm(`确定要将机组状态改为 ${newStatus === 'normal' ? '正常' : '维护中'} 吗？`)) return;
        const res = await apiPut(`/generator-units/${unitId}/status`, { status: newStatus });
        loadUnits();
        alert('机组状态已更新');
    } catch (e) {}
}

function openCreateUnitForm() {
    showModal('新增机组', `
        <div class="form-group">
            <label class="required">机组编号</label>
            <input type="text" id="unitCode" placeholder="例：GEN-001">
        </div>
        <div class="form-group">
            <label class="required">机组名称</label>
            <input type="text" id="unitName" placeholder="例：1号柴油发电机组">
        </div>
        <div class="form-row">
            <div class="form-group">
                <label class="required">额定容量 (kW)</label>
                <input type="number" id="unitCapacity" value="800" min="0">
            </div>
            <div class="form-group">
                <label class="required">油箱容量 (L)</label>
                <input type="number" id="unitTank" value="5000" min="0">
            </div>
        </div>
    `, `
        <button class="btn-secondary" onclick="closeModal()">取消</button>
        <button class="btn-primary" onclick="submitCreateUnit()">确认新增</button>
    `);
}

async function submitCreateUnit() {
    const unit_code = document.getElementById('unitCode').value.trim();
    const unit_name = document.getElementById('unitName').value.trim();
    const capacity_kw = parseInt(document.getElementById('unitCapacity').value);
    const fuel_tank_capacity_l = parseInt(document.getElementById('unitTank').value);
    
    if (!unit_code || !unit_name || !capacity_kw || !fuel_tank_capacity_l) {
        alert('请填写所有必要信息');
        return;
    }
    
    try {
        await apiPost('/generator-units', { unit_code, unit_name, capacity_kw, fuel_tank_capacity_l });
        closeModal();
        loadUnits();
        alert('机组添加成功');
    } catch (e) {}
}

async function loadConfig() {
    const data = await apiGet('/config');
    configCache = data.configs || [];
    const container = document.getElementById('configList');
    
    if (configCache.length === 0) {
        container.innerHTML = `<div class="empty-state">暂无配置</div>`;
        return;
    }
    
    container.innerHTML = configCache.map(c => {
        let displayValue = c.config_value;
        if (c.config_key.includes('threshold') || c.config_key.includes('percent')) {
            displayValue = c.config_value + '%';
        }
        return `
            <div class="config-item">
                <div class="config-item-info">
                    <h4>${c.config_key}</h4>
                    <p>${c.description || ''}</p>
                </div>
                <div class="config-value">${displayValue}</div>
            </div>
        `;
    }).join('');
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('roleSelect').addEventListener('change', (e) => {
        currentRole = e.target.value;
        loadPlans();
    });
    document.getElementById('operatorName').addEventListener('change', (e) => {
        currentUser = e.target.value || '操作员';
    });
    
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => switchView(btn.dataset.view));
    });
    
    document.getElementById('createPlanBtn').addEventListener('click', openCreatePlanForm);
    document.getElementById('createUnitBtn').addEventListener('click', openCreateUnitForm);
    
    document.getElementById('modal').addEventListener('click', (e) => {
        if (e.target.id === 'modal') closeModal();
    });
    
    (async function init() {
        const [unitsData, configData] = await Promise.all([
            apiGet('/generator-units'),
            apiGet('/config')
        ]);
        unitsCache = unitsData.units || [];
        configCache = configData.configs || [];
        loadPlans();
    })();
});
