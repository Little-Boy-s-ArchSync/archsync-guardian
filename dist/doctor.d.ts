export interface DoctorCheck {
    name: string;
    status: "PASS" | "WARN" | "FAIL";
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
    pathValue: string | undefined;
    pnpmHome: string | undefined;
    runGit: (command: string, args: string[], options: {
        encoding: "utf8";
        shell: false;
        windowsHide: true;
    }) => {
        status: number | null;
        stdout: string;
    };
    locateArchSync: () => {
        status: number | null;
        stdout: string;
    };
}
export declare function archsyncLocator(platform: NodeJS.Platform): "where.exe" | "which";
export declare function pathIncludesDirectory(pathValue: string | undefined, directory: string | undefined, platform: NodeJS.Platform): boolean;
export declare function pnpmHomePathMatch(pathValue: string | undefined, pnpmHome: string | undefined, platform: NodeJS.Platform): string | undefined;
export declare function runDoctor(environment?: DoctorEnvironment): DoctorResult;
export declare function formatDoctorResult(result: DoctorResult): string;
//# sourceMappingURL=doctor.d.ts.map