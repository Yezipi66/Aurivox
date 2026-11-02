'use strict'
// 预览拖宽的夹取：最窄 280px，最宽给中栏留 320px，上限按左边条此刻的宽度算。
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const { clampPreviewWidth, PREVIEW_MIN, CENTER_MIN } = require(path.join(__dirname, '..', 'editor', 'drawerWidth.js'))

test('不能比 280px 更窄', () => {
  assert.strictEqual(clampPreviewWidth(100, { stageW: 1920, leftW: 32 }), PREVIEW_MIN)
})

test('左栏收着：最宽到 总宽 − 32 − 320', () => {
  assert.strictEqual(clampPreviewWidth(5000, { stageW: 1920, leftW: 32 }), 1920 - 32 - CENTER_MIN)
})

test('左抽屉开着：上限按抽屉的实际宽度算，中栏不被压成一条缝', () => {
  assert.strictEqual(clampPreviewWidth(5000, { stageW: 1920, leftW: 360 }), 1920 - 360 - CENTER_MIN)
})

test('屏太窄、上限比下限还小时，取下限', () => {
  assert.strictEqual(clampPreviewWidth(500, { stageW: 600, leftW: 360 }), PREVIEW_MIN)
})

test('范围内原样返回（取整）', () => {
  assert.strictEqual(clampPreviewWidth(640.6, { stageW: 1920, leftW: 32 }), 641)
})
