export declare function insertEvent(eventType: string, agentTarget: string | null, payloadJson: string): number;
export declare function markRouted(id: number, result: string): void;
export declare function getUnroutedEvents(): Array<{
    id: number;
    event_type: string;
    agent_target: string;
    payload_json: string;
}>;
//# sourceMappingURL=db.d.ts.map