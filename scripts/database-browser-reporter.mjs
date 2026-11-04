// Only statuses leave the child: real password/cookie values and failure bodies stay in memory.
export default class RequiredBrowserReporter {
  printsToStdio() {
    return true;
  }
  onBegin(_config, suite) {
    this.suite = suite;
  }
  onEnd(result) {
    const tests = this.suite.allTests().map((test) => ({
      title: test.title,
      outcome: test.outcome(),
      expectedStatus: test.expectedStatus,
      statuses: test.results.map((entry) => entry.status),
    }));
    const count = (outcome) => tests.filter((test) => test.outcome === outcome).length;
    console.log(
      JSON.stringify({
        status: "database-password-browser-report",
        result: result.status,
        tests,
        stats: {
          expected: count("expected"),
          skipped: count("skipped"),
          unexpected: count("unexpected"),
          flaky: count("flaky"),
        },
      }),
    );
  }
}
