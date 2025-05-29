import { existsSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { $ } from "bun";

export interface SystemContext {
	user: {
		name: string;
		home: string;
		uid: number;
		gid: number;
		shell: string;
	};
	system: {
		hostname: string;
		platform: NodeJS.Platform;
		arch: string;
		isRoot: boolean;
	};
	hardware: {
		hasFingerprint: boolean;
		hasTpm: boolean;
		hasNvidiaGpu: boolean;
		hasAmdGpu: boolean;
		hasIntelGpu: boolean;
	};
	desktop: {
		session: string | null;
		isWayland: boolean;
		isX11: boolean;
		isGnome: boolean;
		isKde: boolean;
		isNiri: boolean;
	};
}

class SystemContextProvider {
	private context: SystemContext | null = null;

	async getContext(): Promise<SystemContext> {
		if (this.context) {
			return this.context;
		}

		this.context = await this.detectSystemContext();
		return this.context;
	}

	private async detectSystemContext(): Promise<SystemContext> {
		const user = userInfo();

		return {
			user: {
				name: user.username,
				home: user.homedir,
				uid: user.uid,
				gid: user.gid,
				shell: user.shell || process.env.SHELL || "/bin/sh",
			},
			system: {
				hostname: hostname(),
				platform: process.platform,
				arch: process.arch,
				isRoot: user.uid === 0,
			},
			hardware: {
				hasFingerprint: await this.detectFingerprint(),
				hasTpm: await this.detectTpm(),
				hasNvidiaGpu: await this.detectNvidiaGpu(),
				hasAmdGpu: await this.detectAmdGpu(),
				hasIntelGpu: await this.detectIntelGpu(),
			},
			desktop: {
				session:
					process.env.DESKTOP_SESSION ||
					process.env.XDG_SESSION_DESKTOP ||
					null,
				isWayland: process.env.WAYLAND_DISPLAY !== undefined,
				isX11:
					process.env.DISPLAY !== undefined &&
					process.env.WAYLAND_DISPLAY === undefined,
				isGnome: await this.detectGnome(),
				isKde: await this.detectKde(),
				isNiri: await this.detectNiri(),
			},
		};
	}

	private async detectFingerprint(): Promise<boolean> {
		try {
			// Check for fingerprint devices
			const result = await $`ls /sys/class/fingerprint/ 2>/dev/null`.quiet();
			if (result.stdout.trim()) {
				return true;
			}

			// Check USB devices for common fingerprint readers
			const lsusb = await $`lsusb 2>/dev/null || true`.quiet();
			const fingerprintVendors = [
				"138a:", // Validity Sensors
				"06cb:", // Synaptics
				"04f3:", // Elan
				"1c7a:", // LighTuning
				"27c6:", // Goodix
			];

			return fingerprintVendors.some((vendor) =>
				lsusb.stdout.toLowerCase().includes(vendor),
			);
		} catch {
			return false;
		}
	}

	private async detectTpm(): Promise<boolean> {
		try {
			// Check for TPM 2.0
			if (existsSync("/dev/tpm0") || existsSync("/dev/tpmrm0")) {
				return true;
			}

			// Check sysfs
			const tpmCheck =
				await $`ls /sys/class/tpm/tpm* 2>/dev/null || true`.quiet();
			return tpmCheck.stdout.trim() !== "";
		} catch {
			return false;
		}
	}

	private async detectNvidiaGpu(): Promise<boolean> {
		try {
			const lspci = await $`lspci 2>/dev/null | grep -i nvidia || true`.quiet();
			return lspci.stdout.trim() !== "";
		} catch {
			return false;
		}
	}

	private async detectAmdGpu(): Promise<boolean> {
		try {
			const lspci =
				await $`lspci 2>/dev/null | grep -E "(AMD|ATI).*(VGA|Display)" || true`.quiet();
			return lspci.stdout.trim() !== "";
		} catch {
			return false;
		}
	}

	private async detectIntelGpu(): Promise<boolean> {
		try {
			const lspci =
				await $`lspci 2>/dev/null | grep -i "Intel.*Graphics" || true`.quiet();
			return lspci.stdout.trim() !== "";
		} catch {
			return false;
		}
	}

	private async detectGnome(): Promise<boolean> {
		const session =
			process.env.DESKTOP_SESSION || process.env.XDG_SESSION_DESKTOP || "";
		if (session.toLowerCase().includes("gnome")) {
			return true;
		}

		try {
			const gnomeCheck = await $`pgrep -x gnome-shell`.quiet();
			return gnomeCheck.exitCode === 0;
		} catch {
			return false;
		}
	}

	private async detectKde(): Promise<boolean> {
		const session =
			process.env.DESKTOP_SESSION || process.env.XDG_SESSION_DESKTOP || "";
		if (
			session.toLowerCase().includes("plasma") ||
			session.toLowerCase().includes("kde")
		) {
			return true;
		}

		try {
			const kdeCheck = await $`pgrep -x plasmashell`.quiet();
			return kdeCheck.exitCode === 0;
		} catch {
			return false;
		}
	}

	private async detectNiri(): Promise<boolean> {
		const session =
			process.env.DESKTOP_SESSION || process.env.XDG_SESSION_DESKTOP || "";
		if (session.toLowerCase().includes("niri")) {
			return true;
		}

		try {
			const niriCheck = await $`pgrep -x niri`.quiet();
			return niriCheck.exitCode === 0;
		} catch {
			return false;
		}
	}
}

export const systemContext = new SystemContextProvider();
