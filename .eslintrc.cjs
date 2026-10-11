/* eslint-env node */
module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  plugins: ['@typescript-eslint', 'react-refresh'],
  ignorePatterns: ['dist', 'node_modules', '*.cjs'],
  rules: {
    'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': 'error',

    // 架构约束 1（阶段0-前端约定 §2.1）：禁止全量失效缓存
    // 无 queryKey 的 invalidateQueries 会清空整站缓存，是「切 Tab 闪一下」的元凶
    'no-restricted-syntax': [
      'error',
      {
        selector:
          "CallExpression[callee.object.name='queryClient'][callee.property.name='invalidateQueries'][arguments.length=0]",
        message: '禁止全量 invalidateQueries：必须传 queryKey（见 阶段0-前端约定-v1.md §2.1）',
      },
      {
        selector:
          "CallExpression[callee.property.name='invalidateQueries'][arguments.length=0]",
        message: '禁止全量 invalidateQueries：必须传 queryKey（见 阶段0-前端约定-v1.md §2.1）',
      },
    ],
  },
};
