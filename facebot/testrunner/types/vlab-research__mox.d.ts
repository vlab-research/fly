declare module '@vlab-research/mox' {
  export interface Field {
    metadata: string;
    [key: string]: any;
  }

  export interface SyntheticEvent {
    type: string;
    value: Record<string, any>;
  }

  export function makeQR(field: Field, userId: string, index: number): any;
  export function makePostback(field: Field, userId: string, index: number): any;
  export function makeTextResponse(userId: string, text: string): any;
  export function makeReferral(userId: string, formId: string): any;
  export function makeSynthetic(userId: string, event: SyntheticEvent): any;
  export function getFields(formPath: string): Field[];
  export function makeNotify(userId: string, metadata: string): any;
  export function makeEcho(message: any, userId: string): any;
} 