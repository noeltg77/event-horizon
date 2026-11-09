import type { CatalogModel, RunConfig } from '../types';
import { getModel, getQuant } from '../catalog';
import { paths } from '../paths';
import { localPath, modelEntryPath, extraFilesFor, isFileDownloaded } from '../models/store';
import { getInstalledEngine, type InstalledEngine } from './engine-manager';
import { LlamaServer, normalizeConfig, type EngineProcess, type ServerPaths } from './llama-server';
import { MlxServer, getInstalledMlx, isMlxDownloaded, mlxModelDir, mlxVariant } from './mlx';

/** Files llama-server needs for a config: weights, an optional speculative file, and a prompt-cache folder for agents. */
export async function llamaPathsFor(model: CatalogModel, config: RunConfig): Promise<ServerPaths> {
  const quant = getQuant(model, config.quantId);
  const p: ServerPaths = { modelPath: modelEntryPath(model, quant) };
  const extra = extraFilesFor(model, config.spec);
  if (extra && (await Promise.all(extra.files.map((f) => isFileDownloaded(extra.model, f)))).every(Boolean)) {
    if (config.spec.type === 'draft-simple') {
      const dq = extra.model.quants.find((q) => q.id === config.spec.draftQuantId);
      if (dq) p.specPath = modelEntryPath(extra.model, dq);
    } else if (model.specHead) {
      p.specPath = localPath(model, model.specHead.file);
    }
  }
  if (config.workload === 'agent') p.slotSavePath = paths.slots;
  return p;
}

/** Create (but don't start) the engine process for a config, on whichever backend it names. */
export async function createEngineProcess(model: CatalogModel, rawConfig: RunConfig, port: number, opts: { llama?: InstalledEngine } = {}): Promise<EngineProcess> {
  let config = normalizeConfig(rawConfig);
  if (config.backend === 'mlx') {
    const mlx = await getInstalledMlx();
    if (!mlx) throw new Error('The MLX engine is not installed (Machine → Engines).');
    const v = mlxVariant(model, config.mlxVariant);
    if (!v) throw new Error(`${model.name} has no MLX ${config.mlxVariant ?? ''} build`);
    if (!(await isMlxDownloaded(v))) throw new Error(`Download the MLX ${v.id} build of ${model.name} first.`);
    let draftDir: string | undefined;
    if (config.spec.type === 'draft-simple' && config.spec.draftModelId) {
      const dm = getModel(config.spec.draftModelId);
      const dv = dm?.mlx?.find((x) => x.bits >= 4);
      if (dv && (await isMlxDownloaded(dv))) draftDir = mlxModelDir(dv);
    }
    if (!draftDir && config.spec.type !== 'none') config = { ...config, spec: { type: 'none' } };
    return new MlxServer(mlx, config, mlxModelDir(v), port, model.id, draftDir);
  }
  const engine = opts.llama ?? (await getInstalledEngine());
  if (!engine) throw new Error('The llama.cpp engine is not installed.');
  const p = await llamaPathsFor(model, config);
  // Drop a speculative setup whose files aren't on disk rather than failing to start
  if (config.spec.type !== 'none' && config.spec.type !== 'ngram-mod' && !p.specPath) config = { ...config, spec: { type: 'none' } };
  return new LlamaServer(engine, config, p, port, model.id);
}
