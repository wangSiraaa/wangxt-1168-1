const http = require('http');

const API_PORT = process.env.API_PORT || 19468;
const API_HOST = process.env.API_HOST || 'localhost';
const BASE_URL = `http://${API_HOST}:${API_PORT}`;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function makeRequest(method, path, data, role) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: API_HOST,
            port: API_PORT,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json',
            }
        };
        if (role) {
            options.headers['X-User-Role'] = role;
        }
        if (data) {
            options.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(data));
        }

        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try {
                    const json = body ? JSON.parse(body) : {};
                    resolve({ statusCode: res.statusCode, data: json });
                } catch (e) {
                    resolve({ statusCode: res.statusCode, data: body, parseError: e });
                }
            });
        });
        req.on('error', reject);
        if (data) req.write(JSON.stringify(data));
        req.end();
    });
}

async function test(name, fn) {
    console.log(`\n📋 ${name}`);
    try {
        const result = await fn();
        if (result === false) {
            console.log(`  ❌ FAILED`);
            process.exitCode = 1;
            return false;
        }
        console.log(`  ✅ PASSED`);
        return true;
    } catch (e) {
        console.log(`  ❌ ERROR: ${e.message}`);
        process.exitCode = 1;
        return false;
    }
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message || 'Assertion failed');
    }
}

async function waitForServer(maxRetries = 30, delayMs = 1000) {
    console.log(`\n⏳ 等待服务启动 (${BASE_URL})...`);
    for (let i = 0; i < maxRetries; i++) {
        try {
            const res = await makeRequest('GET', '/api/health');
            if (res.statusCode === 200 && res.data.status === 'ok') {
                console.log(`  ✅ 服务已就绪`);
                return true;
            }
        } catch (e) {
        }
        if (i < maxRetries - 1) {
            await sleep(delayMs);
        }
    }
    console.log(`  ❌ 服务未能在指定时间内启动`);
    return false;
}

async function runSmokeTest() {
    console.log('='.repeat(60));
    console.log('  数据中心柴油发电机演练系统 - Smoke Test');
    console.log('='.repeat(60));

    let serverProc = null;

    if (!(await waitForServer())) {
        console.log('\n尝试启动本地服务...');
        const { spawn } = require('child_process');
        const path = require('path');
        
        serverProc = spawn('node', [path.join(__dirname, '..', 'server', 'app.js')], {
            env: { ...process.env, API_PORT: String(API_PORT) },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        serverProc.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
        serverProc.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));

        await sleep(2000);

        if (!(await waitForServer())) {
            console.log('\n❌ 无法启动服务，测试终止');
            process.exit(1);
        }
    }

    const cleanup = () => {
        if (serverProc) {
            try { serverProc.kill(); } catch (e) {}
        }
    };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(); });

    let planId = null;
    let loadRecordId = null;

    console.log('\n' + '='.repeat(60));
    console.log('  测试阶段一：系统初始化与基础数据');
    console.log('='.repeat(60));

    await test('获取角色列表', async () => {
        const res = await makeRequest('GET', '/api/roles');
        assert(res.statusCode === 200, `状态码应为200，实际 ${res.statusCode}`);
        assert(Array.isArray(res.data.roles), '应返回roles数组');
        assert(res.data.roles.length === 3, `应有3个角色`);
        console.log(`    角色：${res.data.roles.map(r => r.name).join(', ')}`);
    });

    await test('获取系统配置', async () => {
        const res = await makeRequest('GET', '/api/config');
        assert(res.statusCode === 200);
        assert(Array.isArray(res.data.configs));
        const upsCfg = res.data.configs.find(c => c.config_key === 'ups_margin_threshold');
        const fuelCfg = res.data.configs.find(c => c.config_key === 'fuel_level_threshold');
        assert(upsCfg, '应有UPS余量阈值配置');
        assert(fuelCfg, '应有油位阈值配置');
        console.log(`    UPS阈值: ${upsCfg.config_value}%, 油位阈值: ${fuelCfg.config_value}%`);
    });

    await test('获取机组列表', async () => {
        const res = await makeRequest('GET', '/api/generator-units');
        assert(res.statusCode === 200);
        assert(Array.isArray(res.data.units));
        assert(res.data.units.length >= 1, '至少应有1台机组');
        console.log(`    机组数量: ${res.data.units.length}`);
    });

    console.log('\n' + '='.repeat(60));
    console.log('  测试阶段二：UPS余量校验');
    console.log('='.repeat(60));

    await test('UPS余量不足时不能创建演练计划', async () => {
        const res = await makeRequest('POST', '/api/drill-plans', {
            plan_name: 'UPS不足测试演练',
            unit_id: 1,
            initiator: '测试值班员',
            ups_margin_percent: 10
        }, 'duty_operator');
        assert(res.statusCode === 400, '应返回400错误');
        assert(res.data.error && res.data.error.includes('UPS余量不足'), '应提示UPS余量不足');
        console.log(`    错误信息: ${res.data.error}`);
    });

    console.log('\n' + '='.repeat(60));
    console.log('  测试阶段三：完整演练流程');
    console.log('='.repeat(60));

    await test('值班员创建演练计划', async () => {
        const res = await makeRequest('POST', '/api/drill-plans', {
            plan_name: 'Smoke Test 完整演练',
            unit_id: 1,
            initiator: 'SmokeTest-值班员',
            ups_margin_percent: 60,
            remarks: '自动化冒烟测试演练'
        }, 'duty_operator');
        assert(res.statusCode === 200, `状态码应为200，实际 ${res.statusCode}`);
        assert(res.data.id, '应返回计划ID');
        planId = res.data.id;
        console.log(`    计划ID: ${planId}, 编号: ${res.data.plan_code}`);
    });

    await test('非值班员不能创建演练计划', async () => {
        const res = await makeRequest('POST', '/api/drill-plans', {
            plan_name: '权限测试',
            unit_id: 1,
            initiator: '测试',
            ups_margin_percent: 50
        }, 'facility_engineer');
        assert(res.statusCode === 403, '设施工程师应被拒绝创建计划');
    });

    await test('值班员开始演练', async () => {
        const res = await makeRequest('POST', `/api/drill-plans/${planId}/start`, {}, 'duty_operator');
        assert(res.statusCode === 200);
        assert(res.data.status === 'in_progress', '状态应为进行中');
        console.log(`    演练开始时间: ${res.data.actual_start_time}`);
    });

    await test('设施工程师记录负载切换', async () => {
        const res = await makeRequest('POST', `/api/drill-plans/${planId}/load-switch`, {
            switch_type: '市电转发电机',
            load_kw: 650,
            switch_time: new Date().toISOString(),
            recorded_by: 'SmokeTest-工程师'
        }, 'facility_engineer');
        assert(res.statusCode === 200);
        assert(res.data.id, '应返回负载记录ID');
        loadRecordId = res.data.id;
        console.log(`    负载记录ID: ${loadRecordId}`);
    });

    await test('设施工程师记录油位（正常）', async () => {
        const res = await makeRequest('POST', `/api/drill-plans/${planId}/fuel-level`, {
            fuel_level_l: 4200,
            recorded_by: 'SmokeTest-工程师'
        }, 'facility_engineer');
        assert(res.statusCode === 200);
        assert(res.data.below_threshold === false, '油位应正常');
        assert(!res.data.warning, '不应有警告');
        console.log(`    油位: ${res.data.fuel_level_percent}%`);
    });

    await test('设施工程师记录油位（低于阈值）', async () => {
        const res = await makeRequest('POST', `/api/drill-plans/${planId}/fuel-level`, {
            fuel_level_l: 800,
            recorded_by: 'SmokeTest-工程师'
        }, 'facility_engineer');
        assert(res.statusCode === 200);
        assert(res.data.below_threshold === true, '应标记低于阈值');
        assert(res.data.warning, '应有补油警告');
        console.log(`    油位: ${res.data.fuel_level_percent}% - ${res.data.warning}`);
    });

    await test('安全经理确认市电恢复', async () => {
        const res = await makeRequest('POST', `/api/drill-plans/${planId}/confirm-recovery`, {
            recovery_time: new Date().toISOString(),
            confirmed_by: 'SmokeTest-安全经理'
        }, 'safety_manager');
        assert(res.statusCode === 200);
        console.log(`    已确认市电恢复`);
    });

    await test('恢复确认后不能修改切换时间', async () => {
        const res = await makeRequest('PUT', `/api/load-switch-records/${loadRecordId}`, {
            switch_time: new Date().toISOString()
        }, 'facility_engineer');
        assert(res.statusCode === 400, '应返回400错误');
        assert(res.data.error && res.data.error.includes('已锁定'), '应提示已锁定');
        console.log(`    错误信息: ${res.data.error}`);
    });

    await test('值班员完成演练', async () => {
        const res = await makeRequest('POST', `/api/drill-plans/${planId}/complete`, {}, 'duty_operator');
        assert(res.statusCode === 200);
        assert(res.data.status === 'completed', '状态应为已完成');
        console.log(`    演练完成`);
    });

    console.log('\n' + '='.repeat(60));
    console.log('  测试阶段四：演练汇总查询');
    console.log('='.repeat(60));

    await test('查询演练汇总', async () => {
        const res = await makeRequest('GET', `/api/drill-summary/${planId}`);
        assert(res.statusCode === 200);
        assert(res.data.plan, '应有计划数据');
        assert(res.data.plan.status === 'completed', '计划状态应为已完成');
        assert(res.data.load_switch_records.length >= 1, '至少1条负载记录');
        assert(res.data.fuel_level_records.length >= 2, '至少2条油位记录');
        assert(res.data.recovery_record, '应有恢复记录');
        assert(res.data.can_edit_load_switch === false, '不能再编辑负载切换');
        console.log(`    计划状态: ${res.data.plan.status_name}`);
        console.log(`    负载记录: ${res.data.load_switch_records.length} 条`);
        console.log(`    油位记录: ${res.data.fuel_level_records.length} 条`);
        console.log(`    恢复确认人: ${res.data.recovery_record.confirmed_by}`);
        const lowFuel = res.data.fuel_level_records.find(r => r.below_threshold);
        assert(lowFuel, '应有低于阈值的油位记录');
        assert(res.data.load_switch_records.every(r => r.is_locked), '所有负载记录应已锁定');
        console.log(`    所有负载切换记录已锁定: ✅`);
    });

    await test('查询演练计划列表', async () => {
        const res = await makeRequest('GET', '/api/drill-plans');
        assert(res.statusCode === 200);
        assert(res.data.plans.length >= 1);
        const plan = res.data.plans.find(p => p.id === planId);
        assert(plan, '应能找到刚创建的演练计划');
        assert(plan.status === 'completed');
        assert(plan.recovery_confirmed === 1, '应显示已确认恢复');
    });

    console.log('\n' + '='.repeat(60));
    console.log('  测试完成');
    console.log('='.repeat(60));

    if (process.exitCode === 1) {
        console.log('\n❌ 部分测试失败');
        cleanup();
        process.exit(1);
    } else {
        console.log('\n🎉 所有测试通过！演练系统工作正常！');
        console.log(`\n💡 访问地址: http://localhost:${API_PORT}`);
    }
}

runSmokeTest().catch(err => {
    console.error('\n❌ Smoke test error:', err);
    process.exit(1);
});
