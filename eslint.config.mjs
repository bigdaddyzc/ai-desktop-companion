import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'release/**',
      'node_modules/**',
      'test-results/**',
      'playwright-report/**',
      '.tools/**',
      '**/.pio/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  // 钩子脚本由对方用裸 node 跑，只能是 CommonJS。
  {
    files: ['src/desktop/hook/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  // 分层规则落成可检查的约束：core 是纯领域逻辑，不碰 React、Electron、文件系统和网络。
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'react', 'react-dom', 'serialport'],
              message: 'core 不依赖 UI/桌面/硬件库。',
            },
            {
              group: ['node:*', 'fs', 'path', 'child_process', 'os', 'net', 'http', 'https'],
              message: 'core 不碰文件系统与网络。',
            },
            {
              group: ['../desktop/*', '../renderer/*'],
              message: 'core 不反向依赖 desktop / renderer。',
            },
          ],
        },
      ],
    },
  },
  // 渲染层只通过 preload 桥与主进程说话。
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'node:*', 'serialport'],
              message: '渲染层不直接访问 Node/Electron。',
            },
            { group: ['../desktop/*'], message: '渲染层不引用主进程代码。' },
          ],
        },
      ],
    },
  },
);
