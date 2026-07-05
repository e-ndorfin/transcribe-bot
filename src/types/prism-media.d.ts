declare module "prism-media" {
  import { Transform } from "node:stream";

  namespace prism {
    namespace opus {
      class Decoder extends Transform {
        constructor(options: { rate: number; channels: number; frameSize: number });
      }
    }
  }

  export = prism;
}
