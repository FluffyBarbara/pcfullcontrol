'use strict';
// Проверка кода: ловит обращения к несуществующим переменным, опечатки, недостижимый код и т. п.
const js = require('@eslint/js');
const globals = require('globals');

const rules = {
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-control-regex': 'off', // разбор вывода консольных программ — управляющие символы нужны
  'no-useless-escape': 'off',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-useless-assignment': 'off', // начальные значения «на всякий случай» перед try — осознанно
  'preserve-caught-error': 'off', // понятное сообщение для пользователя важнее цепочки причин
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
};

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'dist-android/**', 'android-app/node_modules/**', 'android-app/android/**', 'android-app/www/jsQR.js', 'android-app/www/icons.js', 'android-app/www/sig.js', 'build/**', 'out/**'] },
  js.configs.recommended,
  {
    files: ['src/main/**/*.js', 'tests/**/*.js', 'scripts/**/*.js', 'android-app/scripts/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules,
  },
  // Страницы собраны из нескольких скриптов: общие имена объявлены в одном файле и используются в других
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.browser, ...{ $: 'readonly', $$: 'readonly', Changelog: 'readonly', Extras: 'readonly', Icons: 'readonly', More: 'readonly', Music: 'readonly', Optimize: 'readonly', STATE: 'writable', Tips: 'readonly', api: 'readonly', closeModal: 'readonly', confirmModal: 'readonly', drawChart: 'readonly', el: 'readonly', fmtBytes: 'readonly', ic: 'readonly', openModal: 'readonly', page: 'writable', promptModal: 'readonly', secret: 'readonly', toast: 'readonly' } } },
    rules: { ...rules, 'no-redeclare': ['error', { builtinGlobals: false }], 'no-unused-vars': ['error', { vars: 'local', args: 'none', caughtErrors: 'none' }] },
  },
  {
    files: ['src/mobile/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.browser, ...{ $: 'readonly', $$: 'readonly', INFO: 'writable', IS_IOS: 'readonly', Icons: 'readonly', M2: 'readonly', MExtras: 'readonly', MOptimize: 'readonly', PcfcSig: 'readonly', RemoteControl: 'readonly', SHELL: 'readonly', Tips: 'readonly', api: 'readonly', closeSheet: 'readonly', confirmSheet: 'readonly', el: 'readonly', fmtBytes: 'readonly', haptic: 'readonly', ic: 'readonly', loadMore: 'readonly', morePane: 'writable', openSheet: 'readonly', secret: 'readonly', signedFetch: 'readonly', store: 'readonly', switchTab: 'readonly', tab: 'writable', toast: 'readonly', token: 'writable' } } },
    rules: { ...rules, 'no-redeclare': ['error', { builtinGlobals: false }], 'no-unused-vars': ['error', { vars: 'local', args: 'none', caughtErrors: 'none' }] },
  },
  {
    files: ['android-app/www/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.browser, ...{ Icons: 'readonly', PcfcSig: 'readonly', jsQR: 'readonly' } } },
    rules: { ...rules, 'no-redeclare': ['error', { builtinGlobals: false }] },
  },
  {
    files: ['scripts/e2e-rtc.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['src/shared/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.browser, ...globals.node } },
    rules,
  },
];
