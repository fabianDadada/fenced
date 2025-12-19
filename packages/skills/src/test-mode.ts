const TEST_FLAG =
  process.env.FENCED_TEST_SKILLS === '1' ||
  process.env.NODE_ENV === 'test' ||
  process.env.BUN_TESTING === '1';

export function isTestSkillsMode(): boolean {
  return TEST_FLAG;
}
