/**
 * 注解（装饰器）方式示例
 *
 * 与 nea-boot 的 @Service / @Controller 风格完全一致。
 *
 * 运行前：
 * 1. 启动 Nacos（默认 127.0.0.1:8848）
 * 2. 在控制台创建配置：
 *    - Data ID: demo-app.yml, Group: DEFAULT_GROUP
 *      内容：
 *        app:
 *          greeting: hello from nacos
 *        service:
 *          port: 3040
 *          name: demo
 *    - Data ID: demo-extra.yml, Group: DEV_GROUP
 *      内容：
 *        extra:
 *          flag: dev-enabled
 * 3. 运行：npx tsx examples/annotations.ts
 */
import { Controller, Get, Service, AutoWired } from 'nea-boot';
import {
    EnableNacos,
    NacosConfig,
    NacosService,
    NacosValue,
    bootstrapWithNacos,
} from '../src/index';

// ---------------------------------------------------------------- 组件

@Service('greeter')
class Greeter {
    /** 热更新：Nacos 上改了 app.greeting，这个字段会自动刷新 */
    @NacosValue('app.greeting:hello from local', 'string')
    private greeting!: string;

    @NacosValue('service.name:local-app', 'string')
    private appName!: string;

    /** 来自 DEV_GROUP 的配置 */
    @NacosValue('extra.flag:none', 'string')
    private flag!: string;

    info() {
        return {
            greeting: this.greeting,
            appName: this.appName,
            flag: this.flag,
        };
    }
}

@Controller('/api')
class ApiController {
    @AutoWired('greeter')
    private greeter!: Greeter;

    @Get('/info')
    info() {
        return this.greeter.info();
    }
}

// ---------------------------------------------------------------- 注解声明

@EnableNacos({
    serverAddr: process.env.NACOS_ADDR || '127.0.0.1:8848',
    namespace: process.env.NACOS_NAMESPACE || '',
    watch: true,
    onConfigChange: (config, changed) => {
        console.log(`[example] 配置 ${changed.dataId} 已变更`);
    },
})
@NacosConfig({ dataId: 'demo-app.yml' })
@NacosConfig({ dataId: 'demo-extra.yml', group: 'DEV_GROUP' })
@NacosService({
    name: 'nea-boot-cloud-nacos-demo',
    groupName: 'DEFAULT_GROUP',
    metadata: { version: '0.1.0' },
})
class App {}

// ---------------------------------------------------------------- 启动

async function main() {
    const nacos = await bootstrapWithNacos({
        port: Number(process.env.PORT) || 3040,
        scanPath: [new URL('.', import.meta.url).pathname],
    });

    console.log('[example] 启动完成，状态:', nacos.getStatus());
}

main().catch(e => {
    console.error('[example] 启动失败:', e.message);
    process.exit(1);
});
