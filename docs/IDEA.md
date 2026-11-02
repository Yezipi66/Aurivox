# Aurivox

一句话目标：**名片（`manifest.json`）是唯一事实源** —— 平台替某个引擎做过的适配，
一律收敛成名片的派生物；加第二台引擎时 `lib/` 与 `web/` 不需要改。

- 方向（要做成什么样）：[`ENGINE_ONBOARDING_STATUS.md`](./ENGINE_ONBOARDING_STATUS.md) 的七条目标
- 进度（现在在哪、下一刀）：[`ONBOARDING_PLAN.md`](./ONBOARDING_PLAN.md)
- 行为（为什么是这样）：[`ENGINE_ONBOARDING_CONTRACT.md`](./ENGINE_ONBOARDING_CONTRACT.md)
- 当前这条重构线：[issue #26 外围契约化重构（三刀）](https://github.com/Yezipi66/Aurivox/issues/26)

> 2026-11-01 口径订正：旧表述「compatible with ALL TTS models」作废——Engine Contract 已退休，
> GPT-SoVITS / IndexTTS2 的名片是遗留实现数据，不是新引擎模板（见 [`README.md`](./README.md) 顶部声明）。
> 训练链（人声分离 / 切片 / ASR / S1 / S2）仍绑死 GSV，这一点上旧承诺从未兼现。