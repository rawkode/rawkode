import { Action, type ActionContext, type SideEffect } from "../action.ts";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { execSync } from "node:child_process";

export interface HttpDownloadConfig {
	url: string;
	destination: string;
	checksum?: {
		algorithm: "sha256" | "sha512" | "md5";
		value: string;
	};
	mode?: number;
}

export class HttpDownloadAction extends Action<HttpDownloadConfig> {
	private calculateChecksum(filePath: string, algorithm: string): string {
		const content = readFileSync(filePath);
		return createHash(algorithm).update(content).digest("hex");
	}

	private fileMatchesChecksum(filePath: string): boolean {
		if (!this.config.checksum) return false;
		if (!existsSync(filePath)) return false;

		try {
			const currentChecksum = this.calculateChecksum(filePath, this.config.checksum.algorithm);
			return currentChecksum === this.config.checksum.value;
		} catch {
			return false;
		}
	}

	async plan(context: ActionContext): Promise<SideEffect[]> {
		const exists = existsSync(this.config.destination);
		
		// If file exists and checksum matches, no action needed
		if (exists && this.fileMatchesChecksum(this.config.destination)) {
			return [];
		}

		return [
			{
				type: exists ? "file_modify" : "file_create",
				description: `Download ${this.config.url} to ${this.config.destination}`,
				target: this.config.destination,
				metadata: {
					url: this.config.url,
					checksum: this.config.checksum,
					mode: this.config.mode,
				},
			},
		];
	}

	async apply(context: ActionContext): Promise<void> {
		if (context.dryRun) return;

		// Skip if file already exists with correct checksum
		if (existsSync(this.config.destination) && this.fileMatchesChecksum(this.config.destination)) {
			if (context.verbose) {
				console.log(`File ${this.config.destination} already exists with correct checksum, skipping download`);
			}
			return;
		}

		// Ensure directory exists
		const dir = path.dirname(this.config.destination);
		mkdirSync(dir, { recursive: true });

		// Download file using curl
		const tempFile = `${this.config.destination}.tmp`;
		try {
			execSync(`curl -L -o "${tempFile}" "${this.config.url}"`, {
				stdio: context.verbose ? "inherit" : "ignore",
			});

			// Verify checksum if provided
			if (this.config.checksum) {
				const downloadedChecksum = this.calculateChecksum(tempFile, this.config.checksum.algorithm);
				if (downloadedChecksum !== this.config.checksum.value) {
					throw new Error(
						`Checksum mismatch: expected ${this.config.checksum.value}, got ${downloadedChecksum}`
					);
				}
			}

			// Move temp file to final destination
			execSync(`mv "${tempFile}" "${this.config.destination}"`);

			// Set permissions if specified
			if (this.config.mode) {
				const fs = await import("node:fs");
				fs.chmodSync(this.config.destination, this.config.mode);
			}
		} catch (error) {
			// Clean up temp file on error
			try {
				const fs = await import("node:fs");
				fs.unlinkSync(tempFile);
			} catch {}
			throw error;
		}
	}
}