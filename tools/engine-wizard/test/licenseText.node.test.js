'use strict'
// LICENSE 正文识别：只认上游自己声明的标准短语，认不出返回 null。
const assert = require('node:assert')
const { test } = require('node:test')

const { recognizeLicenseText, probeProject } = require('../core/probe.js')

test('Apache 标准头部', () => {
  const t = '                                 Apache License\n' +
    '                           Version 2.0, January 2004\n' +
    '                        http://www.apache.org/licenses/\n'
  assert.strictEqual(recognizeLicenseText(t), 'Apache-2.0')
})

test('MIT 标准头部（Permission is hereby granted 形态）', () => {
  const t = 'MIT License\n\nCopyright (c) 2024 Someone\n\n' +
    'Permission is hereby granted, free of charge, to any person obtaining a copy\n'
  assert.strictEqual(recognizeLicenseText(t), 'MIT')
})

test('单行形态：整篇就是一行 MIT', () => {
  assert.strictEqual(recognizeLicenseText('MIT'), 'MIT')
  assert.strictEqual(recognizeLicenseText('  Apache-2.0  '), 'Apache-2.0')
})

test('SPDX 标识行', () => {
  assert.strictEqual(recognizeLicenseText('SPDX-License-Identifier: BSD-3-Clause\n'), 'BSD-3-Clause')
})

test('BSD 两版：有 neither the name 是 3-Clause', () => {
  const b2 = 'Redistribution and use in source and binary forms, with or without\n' +
    'modification, are permitted provided that the following conditions are met:\n'
  assert.strictEqual(recognizeLicenseText(b2), 'BSD-2-Clause')
  const b3 = b2 + '3. Neither the name of the copyright holder nor the names\n'
  assert.strictEqual(recognizeLicenseText(b3), 'BSD-3-Clause')
})

test('GPL 三版与 LGPL、AGPL', () => {
  assert.strictEqual(recognizeLicenseText('GNU GENERAL PUBLIC LICENSE\n Version 3, 29 June 2007'), 'GPL-3.0')
  assert.strictEqual(recognizeLicenseText('GNU GENERAL PUBLIC LICENSE\n Version 2, June 1991'), 'GPL-2.0')
  assert.strictEqual(recognizeLicenseText('GNU LESSER GENERAL PUBLIC LICENSE\n Version 3, 29 June 2007'), 'LGPL-3.0')
  assert.strictEqual(recognizeLicenseText('GNU AFFERO GENERAL PUBLIC LICENSE\n Version 3, 19 November 2007'), 'AGPL-3.0')
})

test('MPL 与 Unlicense', () => {
  assert.strictEqual(recognizeLicenseText('Mozilla Public License Version 2.0'), 'MPL-2.0')
  assert.strictEqual(recognizeLicenseText('This is free and unencumbered software released into the public domain.'), 'Unlicense')
})

test('空文件 / 空白 / 非字符串 ⇒ null，不编', () => {
  assert.strictEqual(recognizeLicenseText(''), null)
  assert.strictEqual(recognizeLicenseText('   \n  \n'), null)
  assert.strictEqual(recognizeLicenseText(null), null)
  assert.strictEqual(recognizeLicenseText(undefined), null)
})

test('自定义协议 / 普通英文 ⇒ null，不靠相似度猜', () => {
  const custom = 'Internal Use License\n\nThis software may be used within the company only.\n'
  assert.strictEqual(recognizeLicenseText(custom), null)
  assert.strictEqual(recognizeLicenseText('All rights reserved. Contact legal@example.com for terms.'), null)
})

test('不在已知表里的单行词不认（避免把普通英文当标识）', () => {
  assert.strictEqual(recognizeLicenseText('Proprietary'), null)
  assert.strictEqual(recognizeLicenseText('Copyright'), null)
})

test('probeProject：有正文时填 license 与来源，evidence 是 identifier', () => {
  const r = probeProject({
    licenseFile: 'LICENSE',
    licenseText: 'Apache License\nVersion 2.0, January 2004\n',
    filenames: ['LICENSE'],
  })
  assert.strictEqual(r.meta.license, 'Apache-2.0')
  assert.strictEqual(r.meta.licenseEvidence, 'identifier')
  assert.ok(/LICENSE/.test(r.meta.licenseFrom), '来源要指明是 LICENSE 正文')
})

test('probeProject：正文认不出 ⇒ license 为 null，evidence 是 file-only', () => {
  const r = probeProject({
    licenseFile: 'LICENSE',
    licenseText: 'Internal Use License\ncompany only\n',
    filenames: ['LICENSE'],
  })
  assert.strictEqual(r.meta.license, null)
  assert.strictEqual(r.meta.licenseEvidence, 'file-only')
  assert.strictEqual(r.meta.licenseFile, 'LICENSE')
})

test('probeProject：pyproject 的 license 优先于正文', () => {
  const r = probeProject({
    pyproject: '[project]\nname = "x"\nlicense = "BSD-2-Clause"\n',
    licenseFile: 'LICENSE',
    licenseText: 'Apache License\nVersion 2.0, January 2004\n',
    filenames: ['LICENSE', 'pyproject.toml'],
  })
  assert.strictEqual(r.meta.license, 'BSD-2-Clause', 'pyproject 是最精确的来源')
  assert.strictEqual(r.meta.licenseFrom, 'pyproject.toml [project.license]')
})

test('probeProject：没有 license 文件也没有正文 ⇒ 都是 null', () => {
  const r = probeProject({ filenames: [] })
  assert.strictEqual(r.meta.license, null)
  assert.strictEqual(r.meta.licenseEvidence, null)
})
