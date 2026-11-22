// 分段用的框：一段内容占一个小边框，让「这几格属于同一件事」由边框表达，
// 不靠行距暗示。第 4 步的可选能力区（输出格式、辅助参考音频、多权重位）
// 与第 2 步的安装配置区共用这一份，两处形状必须一致。
//   数值取自项目 styles.css 的 .field / .control 那一档：
//   边框 1px var(--border)、圆角 6px、内边距 6px 8px。
export const BOX = {
  marginBottom: 6,
  padding: '6px 8px',
  border: '1px solid var(--border)',
  borderRadius: 6,
}

// 分段框的间距档位：相邻两段之间留 8px，段内字段之间留 6px。
// 写成常量是因为 styleguard 禁止裸 px 圆角，间距也一并走同一处定义。
export const BOX_GAP = 8