import { AsyncLocalStorage } from "node:async_hooks";

const singleAttemptScope = new AsyncLocalStorage();

export function withSingleAttemptRequests(task) {
  return singleAttemptScope.run(true, task);
}

export function isSingleAttemptRequestScope() {
  return singleAttemptScope.getStore() === true;
}

export function bindRequestPolicy(task) {
  const singleAttempt = isSingleAttemptRequestScope();
  return () => singleAttemptScope.run(singleAttempt, task);
}
