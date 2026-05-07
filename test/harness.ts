type TestCase = {
  name: string;
  fn: () => void | Promise<void>;
};

const tests: TestCase[] = [];

export function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

export async function run() {
  let failed = 0;
  for (const entry of tests) {
    try {
      await entry.fn();
      console.log(`ok - ${entry.name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${entry.name}`);
      console.error(error);
    }
  }
  if (failed > 0) {
    throw new Error(`${failed}/${tests.length} tests failed`);
  }
  console.log(`${tests.length}/${tests.length} tests passed`);
}
