// Pruebas de las reglas del navegador compartido (sistema/navegador/local-browser-rules.ts). Se ejecutan en cada
// compilación de GitHub antes de crear el instalador: node --test "sistema/pruebas/*.test.mjs"
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  agentPageUrl, browserAction, isLocalSite, isWriteAction, localAddressToUrl, openSecrets, passwordValues, riskyAction, riskyClick,
  sealSecrets, siteMatches, snapshotElement, typedValues,
} from '../navegador/local-browser-rules.ts'

test('webs locales y de prueba', () => {
  for (const url of ['http://localhost:4310/', 'http://127.0.0.1:8080/x', 'http://[::1]:3000/', 'https://app.localhost/', 'http://shop.test/', 'http://nas.local/']) {
    assert.equal(isLocalSite(url), true, url)
  }
  for (const url of ['https://example.com/', 'https://localhost.example.com/', 'https://test.example.com/', 'about:blank', 'no es una dirección']) {
    assert.equal(isLocalSite(url), false, url)
  }
})

test('cada contraseña, en su web', () => {
  assert.equal(siteMatches('example.com', 'https://example.com/login'), true)
  assert.equal(siteMatches('example.com', 'https://www.example.com/login'), true)
  assert.equal(siteMatches('www.example.com', 'https://example.com/'), true)
  assert.equal(siteMatches('example.com', 'https://accounts.example.com/'), true)
  assert.equal(siteMatches('https://example.com/wp-admin', 'https://example.com/wp-login.php'), true)
  assert.equal(siteMatches('example.com', 'https://example.com.evil.net/'), false)
  assert.equal(siteMatches('example.com', 'https://notexample.com/'), false)
  assert.equal(siteMatches('accounts.example.com', 'https://example.com/'), false)
  assert.equal(siteMatches('', 'https://example.com/'), false)
})

test('acciones que escriben en la página', () => {
  assert.equal(browserAction('mcp__playwright-mcp__browser_click'), 'click')
  assert.equal(browserAction('bash'), undefined)
  for (const action of ['click', 'type', 'fill_form', 'press_key', 'evaluate', 'file_upload', 'handle_dialog']) assert.equal(isWriteAction(action), true, action)
  for (const action of ['navigate', 'snapshot', 'find', 'tabs', 'wait_for', 'mouse_wheel', 'take_screenshot', 'navigate_back']) assert.equal(isWriteAction(action), false, action)
})

test('lo que se escribe en los campos', () => {
  assert.deepEqual(typedValues('type', { target: 'e3', text: 'MI_CLAVE' }), ['MI_CLAVE'])
  assert.deepEqual(typedValues('fill_form', { fields: [{ name: 'a', value: 'x' }, { name: 'b', value: 'MI_CLAVE' }, { name: 'c' }] }), ['x', 'MI_CLAVE'])
  assert.deepEqual(typedValues('click', { target: 'e1' }), [])
})

const PAGE = [
  '- generic [ref=e1]:',
  '  - textbox "Mensaje" [ref=e2]',
  '  - button "Enviar" [ref=e3] [cursor=pointer]',
  '  - button "Continuar" [ref=e4]',
  '  - link "Publicar un anuncio" [ref=e5]:',
  '  - button "Aceptar todas las cookies" [ref=e6]',
  '  - button "Delete \\"draft\\"" [ref=e7]',
].join('\n')

test('clics que envían algo', () => {
  assert.deepEqual(snapshotElement(PAGE, 'e3'), { role: 'button', name: 'Enviar' })
  assert.deepEqual(snapshotElement(PAGE, 'ref=e7'), { role: 'button', name: 'Delete "draft"' })
  assert.equal(riskyClick('click', { target: 'e3', element: 'Send button' }, PAGE), 'Enviar')
  assert.equal(riskyClick('click', { target: 'e4' }, PAGE), undefined)
  assert.equal(riskyClick('click', { target: 'e5', element: 'Publicar link' }, PAGE), undefined)
  assert.equal(riskyClick('click', { target: 'e6' }, PAGE), undefined)
  assert.equal(riskyClick('click', { target: 'e7' }, PAGE), 'Delete "draft"')
  assert.equal(riskyClick('type', { target: 'e2', text: 'enviar' }, PAGE), undefined)
  // Sin la página, por la descripción del modelo.
  assert.equal(riskyClick('click', { target: 'e99', element: 'Pay now button' }, ''), 'Pay now button')
  assert.equal(riskyClick('click', { target: 'e99', element: 'Next' }, ''), undefined)
})

test('la página del agente, según su última acción', () => {
  assert.equal(agentPageUrl('### Page\n- Page URL: https://example.com/a?b=1\n- Page Title: X'), 'https://example.com/a?b=1')
  assert.equal(agentPageUrl('Done.'), undefined)
})

test('barra de dirección', () => {
  assert.equal(localAddressToUrl('localhost:4310'), 'http://localhost:4310')
  assert.equal(localAddressToUrl('127.0.0.1:8080/x'), 'http://127.0.0.1:8080/x')
  assert.equal(localAddressToUrl('example.com'), 'https://example.com')
  assert.equal(localAddressToUrl('https://example.com/a'), 'https://example.com/a')
  assert.equal(localAddressToUrl('how to bake bread'), 'https://www.bing.com/search?q=how%20to%20bake%20bread')
  assert.throws(() => localAddressToUrl('file:///C:/Windows/win.ini'), /web addresses/)
  assert.throws(() => localAddressToUrl('javascript:alert(1)'), /web addresses/)
})

test('copia de seguridad cifrada de las contraseñas', () => {
  const secrets = [{ name: 'ADMIN', site: 'example.com', value: 'ñ-secreto-1' }, { name: 'OTRA', site: '', value: 'x' }]
  const file = sealSecrets(secrets, 'frase de paso larga')
  assert.equal(file.includes('secreto'), false)
  assert.deepEqual(openSecrets(file, 'frase de paso larga'), secrets)
  assert.throws(() => openSecrets(file, 'otra frase distinta'), /Wrong passphrase/)
  assert.throws(() => openSecrets('{"a":1}', 'frase de paso larga'), /not a passwords backup/)
  assert.throws(() => sealSecrets(secrets, 'corta'), /at least 8/)
})

test('lo que se escribe en campos de contraseña', () => {
  const page = '- textbox "Usuario" [ref=e7]\n- textbox "Contraseña" [ref=e9]\n- textbox "Buscar" [ref=e12]'
  assert.deepEqual(passwordValues('fill_form', { fields: [
    { name: 'Usuario', target: 'e7', value: 'prueba' }, { name: 'Campo 2', target: 'e9', value: 'adivinada' },
  ] }, page), ['adivinada'])
  assert.deepEqual(passwordValues('type', { target: 'e12', text: 'zapatos' }, page), [])
  assert.deepEqual(passwordValues('type', { target: 'e99', element: 'Password field', text: 'BANCO' }, page), ['BANCO'])
  assert.deepEqual(passwordValues('click', { target: 'e9' }, page), [])
})

test('scripts y Enter que envían algo', () => {
  const page = '- textbox "Mensaje" [ref=e3]\n- button "Enviar" [ref=e4]'
  assert.match(riskyAction('evaluate', { function: "() => { document.getElementById('b').click() }" }, page) ?? '', /script/)
  assert.match(riskyAction('evaluate', { function: '() => document.forms[0].requestSubmit()' }, page) ?? '', /script/)
  assert.match(riskyAction('run_code_unsafe', { code: "await page.getByRole('button').click()" }, page) ?? '', /script/)
  assert.equal(riskyAction('evaluate', { function: '() => document.title' }, page), undefined)
  assert.equal(riskyAction('evaluate', { function: '() => [...document.links].map(a => a.href)' }, page), undefined)
  assert.match(riskyAction('press_key', { key: 'Enter' }, page) ?? '', /Enviar/)
  assert.equal(riskyAction('press_key', { key: 'Enter' }, '- searchbox "Buscar" [ref=e1]\n- button "Buscar" [ref=e2]'), undefined)
  assert.equal(riskyAction('press_key', { key: 'ArrowDown' }, page), undefined)
})
