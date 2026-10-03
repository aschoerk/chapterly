/**
 * LLM orchestration — a self-contained, NEW layer (prototype).
 *
 * It splits the former monolithic LlmService/generateImage into:
 *   – LlmTransportService   (completion + images endpoints, log, retries)
 *   – evaluators            (pure: responses/errors → named slots, never throw)
 *   – LlmOrchestratorService(shared primitives over the transport)
 *   – 5 use-case controllers+ dispatch  (plain async functions over slots)
 *   – LlmPostprocessorService(compute + apply chat changes consistently)
 *
 * Nothing here modifies existing code; it only reuses existing leaf helpers
 * (llm-message, llm-sse, LlmLogService, parameter + settings + generation
 * services). Wiring into the modal dialogs happens later.
 */
export * from './types';
export * from './slots';
export * from './evaluators';
export * from './transport';
export * from './context';
export * from './orchestrator';
export * from './usecases';
export * from './flows';
export * from './postprocessor';