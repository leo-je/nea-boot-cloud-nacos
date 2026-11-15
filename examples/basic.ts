/**
 * 完整示例：Nacos 配置中心 + 注册中心
 *
 * 运行前需要：
 * 1. 本地启动 Nacos（默认 127.0.0.1:8848）
 * 2. 在 Nacos 控制台创建配置：
 *    - Data ID: example-app.yml, Group: DEFAULT_GROUP
 *      内容：
 *        service:
 *          port: 3000
 *        app:
 *          greeting: hello from nacos
 * 3. 运行：npx tsx examples/basic.ts
 */
import { Controller, Get, Service, AutoWired, Value } from 'nea-boot';
import { NacosAdapter } from '../src/index';

@Service('greeter')
class Greeter {
    @Value('app.greeting:hello from local', 'string')
    private greeting!: string;

    @Value('service.port:3000', 'number')
    private port!: number;

    greet() {
        return { greeting: this.greeting, port: this.port };
    }
}

@Controller('/api')
class ApiController {
    @AutoWired('greeter')
    private greeter!: Greeter;

    @Get('/hello')
    hello() {
        return this.greeter.greet();
    }
}

async function main() {
    const nacos = new NacosAdapter({
        serverAddr: process.env.NACOS_ADDR || '127.0.0.1:8848',
        namespace: process.env.NACOS_NAMESPACE || '',

        configs: [
            { dataId: 'example-app.yml' },
        ],

        watch: true,
        onConfigChange: (config, changed) => {
            console.log(`[example] 配置 ${changed.dataId} 已变更`);
        },

        serviceName: 'nea-boot-cloud-nacos-example',
        metadata: { version: '0.1.0' },
    });

    await nacos.start({
        port: Number(process.env.PORT) || 3000,
        scanPath: [new URL('.', import.meta.url).pathname],
    });

    console.log('[example] 已启动，状态:', nacos.getStatus());
}

main().catch(e => {
    console.error('[example] 启动失败:', e.message);
    process.exit(1);
});