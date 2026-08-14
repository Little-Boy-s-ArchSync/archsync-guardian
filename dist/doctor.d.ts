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
export interface DoctorEnvironment {
    nodeVersion: string;
    platform: NodeJS.Platform;
    architecture: string;
    runGit: (command: string, args: string[], options: {
        encoding: "utf8";
        shell: false;
        windowsHide: true;
    }) => {
        status: number | null;
        stdout: string;
    };
}
export declare function runDoctor(environment?: DoctorEnvironment): DoctorResult;
export declare function formatDoctorResult(result: DoctorResult): string;
//# sourceMappingURL=doctor.d.ts.map