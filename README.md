# 绕标 · MARK REGATTA

```sh
npm ci
npm run dev
```

```sh
docker compose up --build
```

Docker 默认地址为 http://127.0.0.1:8033。

## 严格绕标

严格赛制不会因穿过引导门和门线而直接换标。裁判以浮标为圆心持续解算：

- 按 `buoySide` 对应的规定旋向累计有符号极角；船头短时反向会减少净绕行角度。
- 净角度达到设定值、出口处位于标外侧，且整个船身扫掠包络未进入保护圈，才确认合规并换到下一个标。
- 连续船位与船首相位会被高密度插值；即使两条艇心轨迹几乎重合，转向相位导致船身扫圈时仍会判为擦碰失效。
- 证据误差带或采样间隔使保护圈边界无法分辨时，尝试保留为 `unconfirmed`，不会推进下一个标。
- 航次会归档每次尝试的高频船位、净角度序列、接触/未确认位置和扫过水域；拖动回看时间即可复查。

核心纯函数位于 `src/features/jury/lib/rounding.ts`，可通过 `evaluateRoundingTrack()`、`RoundingJudge`、`sweptHullPolygons()` 和 `sliceAttemptAt()` 复核。
