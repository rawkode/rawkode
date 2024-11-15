export abstract class Manifest {
	public readonly dependsOn: Manifest[] = [];

	abstract run(): void;
}
