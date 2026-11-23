## 改动

<!-- 一句话说清改了什么、为什么；关联 issue 就写在这里。 -->

## 合并前检查

- [ ] `npm run ci` 本地全绿（或已确认失败与本次改动无关，并在 PR 里说明）
- [ ] 行为改动带了对应断言（`test/` 或 `src/**/test.mjs`），没有为了过 CI 删断言
- [ ] 改了 `package.json` 的 `files` / `exports` / 名称 / 版本时，`npm run check` 通过
- [ ] 改了 CI 或测试脚本时，已同步 `docs/CI.md` 与 README 的「测试」一节

> `main` 受保护：必须通过 PR 合入，且 `ci-ok` 检查为绿、分支基于最新 `main`。见 `docs/CI.md`。
