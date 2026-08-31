import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	parseTodoReplaceResult,
	TODO_REPLACE_REQUEST_EVENT,
	type TodoItemV3,
	type TodoReplaceRequestEnvelopeV1,
	type TodoReplaceResultV1,
} from "todo-protocol";

export type TodoReplaceOutcome =
	| { readonly ok: true; readonly applied: boolean }
	| { readonly ok: false; readonly error: string };

/**
 * Plan → Todo 内部 Mutation 请求：通过版本化同步 envelope 调用 Todo 自己的
 * whole-list replacement。Todo 是 todo:snapshot 的唯一写入者。
 *
 * 前置探测区分“Todo 未加载/禁用”与“已加载但请求失败”；总线不等待 handler，
 * 因此无响应与 handler 异常统一收敛为 fail-closed 的 no-response 结果。
 */
export function requestTodoReplace(
	pi: ExtensionAPI,
	context: ExtensionContext,
	options: { readonly requestId: string; readonly handoffId: string; readonly todos: readonly TodoItemV3[] },
): TodoReplaceOutcome {
	if (!pi.getAllTools().some((tool) => tool.name === "todo_write")) {
		return { ok: false, error: "todo extension is not loaded or is disabled" };
	}
	const sessionId = context.sessionManager.getSessionId();
	let responded = false;
	let result: TodoReplaceResultV1 | undefined;
	const request: TodoReplaceRequestEnvelopeV1 = {
		version: 1,
		requestId: options.requestId,
		sessionId,
		handoffId: options.handoffId,
		todos: options.todos,
		respond(value) {
			responded = true;
			result = value;
		},
	};
	try {
		pi.events.emit(TODO_REPLACE_REQUEST_EVENT, request);
	} catch {
		return { ok: false, error: "todo did not respond to the handoff request" };
	}
	if (!responded) {
		return { ok: false, error: "todo did not respond to the handoff request" };
	}
	const parsed = parseTodoReplaceResult(result);
	if (parsed === null) return { ok: false, error: "todo returned an invalid handoff result" };
	if (parsed.error !== undefined) return { ok: false, error: parsed.error };
	return { ok: true, applied: parsed.applied };
}
