declare module 'r2' {
  interface R2Response {
    body?: any;
    response: any;
    json: Promise<any>;
  }

  interface R2Options {
    json?: any;
    headers?: Record<string, string>;
    [key: string]: any;
  }

  interface R2 {
    (url: string, options?: R2Options): R2Response;
    get(url: string, options?: R2Options): R2Response;
    post(url: string, options?: R2Options): R2Response;
    put(url: string, options?: R2Options): R2Response;
    delete(url: string, options?: R2Options): R2Response;
    head(url: string, options?: R2Options): R2Response;
  }

  const r2: R2;
  export = r2;
} 