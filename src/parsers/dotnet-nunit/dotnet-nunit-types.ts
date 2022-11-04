export interface NunitReport {
  'test-run': TestRun
}

export interface TestRun {
  $: {
    time: string
  }
  'test-suite'?: TestSuite[]
}

export interface TestSuite {
  $: {
    name: string
    tests: string
    errors: string
    failed: string
    skipped: string
    passed: string
    duration: string
  }
  'test-case'?: TestCase[]
  'test-suite'?: TestSuite[]
}

export interface TestCase {
  $: {
    classname: string
    file?: string
    name: string
    duration: string
    result: string
  }
  failure?: Failure
}

export interface Failure {
  'stack-trace': string
  message: string
}