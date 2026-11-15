# nea-boot-cloud-nacos

为 [nea-boot](https://www.npmjs.com/package/nea-boot) 框架提供 **Nacos 配置中心** 与 **注册中心** 适配。

## 安装

```sh
npm install nea-boot-cloud-nacos nea-boot
```

要求 Node.js >= 22（与 nea-boot 2.1+ 一致）。

## 快速开始

```ts
import { NacosAdapter } from 'nea-boot-cloud-nacos';

const nacos = new NacosAdapter({
  serverAddr: '127.0.0.1:8848',
  namespace: 'dev',                    // 命名空间 **ID**，不是名称
  configs: [
    { dataId: 'application.yml' },     // 基础配置
    { dataId: 'my-service.yml', required: true },  // 必需配置，拉不到就启动失败
  ],
  serviceName: 'my-service',           // 传了才注册
});

await nacos.start({ port: 3000, scanPath: ['/src'] });
```

启动顺序由适配器保证：

```
1. 从 Nacos 拉配置  →  2. 合并进 ConfigManager  →  3. nea-boot bootstrap()
→  4. 端口已监听  →  5. 注册到 Nacos  →  6. 安装优雅关闭钩子
```

**第 5 步必须在 bootstrap 之后**：Nacos 一旦有实例就会导流，端口没监听会直接失败。

## 三种使用方式

### 方式零：注解（装饰器）方式 ⭐ 推荐

与 nea-boot 的 `@Service` / `@Controller` 风格一致：

```ts
import { EnableApplication } from 'nea-boot';
import {
  EnableNacos, NacosConfig, NacosService, NacosValue, bootstrapWithNacos,
} from 'nea-boot-cloud-nacos';

@EnableNacos({
  serverAddr: '127.0.0.1:8848',
  namespace: 'dev',
})
@NacosConfig({ dataId: 'application.yml' })
@NacosConfig({ dataId: 'application-dev.yml', group: 'DEV_GROUP' })
@NacosService({ name: 'my-service', groupName: 'DEV_GROUP' })
class App {}

// 统一启动入口（会先拉配置，再启动应用，最后注册）
await bootstrapWithNacos({ port: 3000, scanPath: ['/src'] });
```

**组件里的用法：**

```ts
import { Service } from 'nea-boot';
import { NacosValue } from 'nea-boot-cloud-nacos';

@Service('myService')
class MyService {
  @NacosValue('app.greeting:hello')
  private greeting: string;

  @NacosValue('feature.enabled:false', 'boolean')
  private enabled: boolean;

  @NacosValue('service.port:3000', 'number')
  private port: number;
}
```

#### `@NacosValue` vs `@Value`

| | `@Value`（nea-boot） | `@NacosValue`（本包） |
|---|---|---|
| 注入时机 | 启动时一次 | 启动时 + **每次配置变更** |
| **热更新** | ❌ 不会更新 | ✅ **自动重新赋值** |
| 语法 | `'key:default'` | 完全相同 |
| 数据来源 | `ConfigManager.config` | 同一份（Nacos 合并后）|

`@NacosValue` 的真正价值是**热更新**：Nacos 上改了配置，字段会自动刷新，无需重启。

#### 为什么需要 `bootstrapWithNacos()`

类装饰器是**同步**求值的，而 Nacos 拉配置是**异步**的。
若让 `@EnableNacos` 直接启动，配置还没到手就已经 bootstrap 完了。

因此：
- `@EnableNacos` 只负责**登记连接参数**
- `bootstrapWithNacos()` 负责**异步编排**：拉配置 → 启动 → 注册 → 注入 → 挂热更新

#### ⚠️ 装饰器顺序

TypeScript 类装饰器**从下往上**执行。虽然本包用模块级登记表规避了顺序依赖，
但仍建议把 `@EnableNacos` 写在最上方，语义更清晰：

```ts
@EnableNacos({ ... })      // ← 最上
@EnableApplication({ ... })
class App {}
```

#### 多服务声明

Nacos 一个实例只能注册一个服务名。若声明多个 `@NacosService`，
只有第一个生效，其余会告警。

---

## 另外两种方式（不用注解）

### 方式一：完整接管启动（推荐）

```ts
await nacos.start({ port: 3000, scanPath: ['/src'] });
```

适配器负责：拉配置 → 启动 → 注册 → 装关闭钩子。

### 方式二：只加载配置，自己启动

适合继续使用 `@EnableApplication` 装饰器的项目：

```ts
import { NacosAdapter } from 'nea-boot-cloud-nacos';
import { EnableApplication } from 'nea-boot';

const nacos = new NacosAdapter({
  serverAddr: '127.0.0.1:8848',
  configs: [{ dataId: 'application.yml' }],
});

// 必须在 @EnableApplication 生效前完成
await nacos.loadConfig();

@EnableApplication({ port: 3000, scanPath: ['/src'] })
class App {}
```

> ⚠️ 装饰器在**类定义时**就求值，所以 `await nacos.loadConfig()` 必须写在 `class App {}` 之前，
> 且所在文件需要顶层 await（ESM）或包在 async 函数里。

## 配置中心

### 配置项声明

```ts
configs: [
  {
    dataId: 'application.yml',   // 数据 ID
    group: 'DEFAULT_GROUP',      // 分组，默认 DEFAULT_GROUP
    type: 'yaml',                // 格式：yaml | yml | json | properties | text
    required: false,             // 必需？拉不到就启动失败
  },
]
```

`type` 不写时会按 dataId 扩展名推断（`.yml` / `.yaml` / `.json` / `.properties`）。

### 合并语义

多个配置**按数组顺序**依次深合并，**后面的覆盖前面的**：

```ts
configs: [
  { dataId: 'application.yml' },              // 基础
  { dataId: `application-${profile}.yml` },   // 环境覆盖
  { dataId: 'secrets.yml', required: true },  // 最高优先级
]
```

合并规则（与 nea-boot 的 `deepMerge` 一致）：

| 类型 | 行为 |
|---|---|
| 普通对象 | 递归合并 |
| 数组 | **直接覆盖**（不按 index 合并） |
| 标量 | 覆盖 |
| `null` / `undefined` | 跳过（不覆盖） |

**远端优先于本地**：Nacos 上的值会覆盖 `Application.yml` 里的同名配置。这是配置中心的常规语义。

### 各格式示例

**yaml / yml**

```yaml
service:
  port: 3000
feature:
  enabled: true      # 保留原生 boolean
  retries: 0         # 0 也会正确注入
```

**json**

```json
{ "service": { "port": 3000 } }
```

**properties**（键用 `.` 表示层级，值保持字符串）

```properties
service.port=3000
service.name=my-app
db.url=http://host:5432/db    # 只按第一个 = 切分，值里的 = 会保留
```

> properties 的值一律是字符串，需要 number/boolean 时用 `@Value('service.port', 'number')` 转换。

**text**（原样保存，不参与合并）

```ts
{ dataId: 'config.json', type: 'text' }
```

内容会挂在 `config.nacos.raw['config.json']` 下。

### 监听配置变更

```ts
const nacos = new NacosAdapter({
  // ...
  watch: true,   // 默认 true
  onConfigChange: (merged, changed) => {
    console.log(`配置 ${changed.dataId} 已更新`);
    console.log('合并后的完整配置:', merged);
  },
});
```

> ⚠️ **重要限制**：配置变更只会更新 `ConfigManager.config`。
> **已经注入到组件里的 `@Value` 字段不会自动更新**——因为它们是普通属性，没有响应式机制。
>
> 如果你需要热更新，请在 `onConfigChange` 里自己把新值写回组件，或改用「读取时取值」的方式。

## 注册中心

```ts
const nacos = new NacosAdapter({
  serverAddr: '127.0.0.1:8848',
  serviceName: 'my-service',   // 传了才注册
  ip: '192.168.1.10',          // 可选，默认自动探测本机 IP
  port: 3000,                  // 可选，默认取实际监听端口
  groupName: 'DEFAULT_GROUP',
  clusterName: 'DEFAULT',
  weight: 1,
  ephemeral: true,             // 临时实例（推荐），靠心跳存活
  metadata: { version: '1.0.0' },
});
```

### 服务发现

```ts
const instances = await nacos.discover('user-service');
// [{ ip: '192.168.1.11', port: 3001, metadata: { version: '1.0.0' } }, ...]
```

### 注销

适配器在 `SIGTERM` / `SIGINT` 时会自动注销。也可以手动：

```ts
await nacos.stop();
```

> 主动注销能让流量立刻停止导入，而不是等心跳超时（默认 15s）。生产环境建议保留这个钩子。

## 配置项参考

```ts
interface NacosOptions {
  // ---- 连接 ----
  serverAddr?: string | string[];   // 默认 '127.0.0.1:8848'
  namespace?: string;               // 命名空间 ID，默认 public
  username?: string;                // 开启鉴权时必填
  password?: string;
  timeout?: number;                 // 请求超时 ms，默认 5000

  // ---- 配置中心 ----
  configs?: NacosConfigItem[];
  watch?: boolean;                  // 默认 true
  onConfigChange?: (config, changed) => void;

  // ---- 注册中心 ----
  serviceName?: string;
  ip?: string;
  port?: number;
  groupName?: string;               // 默认 DEFAULT_GROUP
  clusterName?: string;             // 默认 DEFAULT
  weight?: number;                  // 默认 1
  ephemeral?: boolean;              // 默认 true
  metadata?: Record<string, string>;
}
```

## 运行时状态

```ts
nacos.getStatus();
// {
//   configLoaded: true,
//   loadedDataIds: ['application.yml'],
//   registered: true,
//   instance: { ip: '192.168.1.10', port: 3000, serviceName: 'my-service' },
//   lastError: null,
// }
```

## 错误处理策略

| 场景 | 行为 |
|---|---|
| 非必需配置拉取失败 | **记录错误日志，继续启动**（配置中心短暂不可用不应阻断启动）|
| 必需配置（`required: true`）拉取失败或为空 | **启动失败** |
| 配置内容格式错误（如 json 非法） | 非必需 → 告警继续；必需 → 启动失败 |
| 注册失败 | **启动失败**（注册不上意味着流量进不来）|
| 注销失败 | 记录错误，不阻塞关闭（可能留下僵尸实例）|

## 安全说明

- **原型污染防护**：解析 yaml/json/properties 后会递归剔除 `__proto__` / `constructor` / `prototype` 键，深合并时同样跳过
- **不写日志敏感值**：适配器只记录 dataId、group、字节数，不打印配置内容
- **建议开启 Nacos 鉴权**：生产环境配置 `username` / `password`

## 与 nea-boot 的关系

本包是 **纯适配层**，不修改 nea-boot 的任何行为：

- 配置注入仍然走 nea-boot 的 `ConfigManager.config` + `@Value`
- 注册逻辑独立于 nea-boot 的生命周期，只在 bootstrap 后调用
- 因此 nea-boot 升级不会影响本包，反之亦然

## License

MIT
