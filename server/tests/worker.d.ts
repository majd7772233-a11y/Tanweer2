/**
 * The test runtime exposes the very same bindings as production, so the test
 * `env` is the Worker `Env`. Declaring it here keeps the tests type safe.
 */
import type { Env as TanweerEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends TanweerEnv {}
  }
}
