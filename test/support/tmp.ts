// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Create a temporary directory for a test; the caller removes it during clean-up.
 * Each test file wraps this to track the directories it must remove.
 */
export function createTempDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}
