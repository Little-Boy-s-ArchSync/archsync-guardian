export interface DoctorCheck {
    name: string;
    status: "PASS" | "FAIL";
    detail: string;
}
export interface DoctorResult {
    ok: boolean;
    platform: NodeJS.Platform;
    checks: DoctorCheck[];
}
export declare function runDoctor(): DoctorResult;
export declare function formatDoctorResult(result: DoctorResult): string;
//# sourceMappingURL=doctor.d.ts.map