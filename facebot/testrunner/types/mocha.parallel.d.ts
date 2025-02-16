declare module 'mocha.parallel' {
  function parallel(description: string, fn: (this: Mocha.Suite) => void): void;
  namespace parallel {
    export function it(expectation: string, callback?: Mocha.AsyncFunc | Mocha.Func): Mocha.Test;
    export function before(callback: Mocha.AsyncFunc | Mocha.Func): void;
    export function after(callback: Mocha.AsyncFunc | Mocha.Func): void;
    export function beforeEach(callback: Mocha.AsyncFunc | Mocha.Func): void;
    export function afterEach(callback: Mocha.AsyncFunc | Mocha.Func): void;
  }
  export = parallel;
} 