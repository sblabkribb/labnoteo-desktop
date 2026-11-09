// Ported from app/vendor/labnoteo/src/main.ts:3332-3357 sha256:9de7584691c80346
// labnoteO 0.138.0, Apache-2.0.
// Changes: the LabnotePlugin methods become module functions; `this.activeNotePath()` is the `activePath` parameter, `this.settings.globalSampleFolder` the `globalFolder` parameter, and `this.lastExperimentDir` a module variable; `rememberExperiment` is added as the test reset.
import { resolveLocalSampleFolder } from '@labnoteo/core/lib/sampleStorage';

/** The last experiment folder resolved (`labnote/###_*`), kept for non-note files. */
let lastExperimentDir: string | undefined;

/** Sets the remembered experiment. Tests reset it with `rememberExperiment(undefined)`. */
export function rememberExperiment(dir: string | undefined): void {
  lastExperimentDir = dir;
}

/**
 * The Local-scope `resources/labsamples` folder for the sample sidebar and
 * autocomplete.
 *
 * Resolved from the active note's experiment root (`labnote/###_*`), NOT its
 * immediate folder, so any file inside an experiment (a subfolder image, a
 * workflow note, …) maps to the same experiment samples. A note outside any
 * experiment uses its own folder (a vault-root note's is the global one, #70),
 * so samples created there land where its references resolve. The last
 * resolved experiment is remembered only for non-note files (an image, a PDF),
 * which keep the tree on that experiment instead of collapsing to Global.
 */
export function localSampleFolder(activePath: string | undefined, globalFolder: string): string {
  const resolved = resolveLocalSampleFolder(activePath, lastExperimentDir, globalFolder);
  lastExperimentDir = resolved.lastExperimentDir;
  return resolved.folder;
}

/** Whether a Local sample scope can be resolved (an experiment is known). */
export function hasLocalScope(activePath: string | undefined): boolean {
  return activePath !== undefined || lastExperimentDir !== undefined;
}
