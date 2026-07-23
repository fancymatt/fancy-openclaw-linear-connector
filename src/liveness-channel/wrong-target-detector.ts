export interface WrongTargetFlag {
  flagged: boolean;
  reason?: string;
  expected?: string;
  actual?: string;
  delegateAtDispatch?: string;
}

export interface WrongTargetParams {
  ackTarget: string;
  resolvedDelegate: string;
  delegateAtDispatch?: string;
}

export function checkWrongTarget(params: WrongTargetParams): WrongTargetFlag {
  const ackTarget = params.ackTarget.trim();
  const resolvedDelegate = params.resolvedDelegate.trim();

  if (ackTarget === resolvedDelegate) {
    return { flagged: false };
  }

  return {
    flagged: true,
    reason: `INF-224 wrong-target dispatch ack: expected ${resolvedDelegate}, got ${ackTarget}`,
    expected: resolvedDelegate,
    actual: ackTarget,
    delegateAtDispatch: params.delegateAtDispatch,
  };
}
