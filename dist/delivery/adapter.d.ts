import type { OpenClawAssignmentPayload, OpenClawDeliveryRequest, OpenClawDeliveryResult, RouteResult } from "../types";
export interface OpenClawDeliveryAdapter {
    deliver(request: OpenClawDeliveryRequest): Promise<OpenClawDeliveryResult>;
}
export interface OpenClawDeliveryAdapterOptions {
    gatewayUrl: string;
    fetchImpl?: typeof fetch;
}
export declare class HttpOpenClawDeliveryAdapter implements OpenClawDeliveryAdapter {
    private readonly gatewayUrl;
    private readonly fetchImpl;
    constructor(options: OpenClawDeliveryAdapterOptions);
    deliver(request: OpenClawDeliveryRequest): Promise<OpenClawDeliveryResult>;
}
export declare function createAssignmentPayload(route: RouteResult): OpenClawAssignmentPayload;
//# sourceMappingURL=adapter.d.ts.map