import type { Module } from "./module.ts";

export interface DagNode {
	module: Module;
	dependencies: Set<string>;
	dependents: Set<string>;
}

export class ModuleDAG {
	private nodes = new Map<string, DagNode>();

	addModule(module: Module) {
		if (this.nodes.has(module.name)) {
			throw new Error(`Module ${module.name} already exists in DAG`);
		}

		this.nodes.set(module.name, {
			module,
			dependencies: new Set(module.dependencies),
			dependents: new Set(),
		});
	}

	build(): void {
		for (const node of this.nodes.values()) {
			for (const dep of node.dependencies) {
				const depNode = this.nodes.get(dep);
				if (!depNode) {
					throw new Error(
						`Module ${node.module.name} depends on unknown module ${dep}`,
					);
				}
				depNode.dependents.add(node.module.name);
			}
		}

		this.validateNoCycles();
	}

	private validateNoCycles(): void {
		const visited = new Set<string>();
		const recursionStack = new Set<string>();

		const hasCycle = (name: string): boolean => {
			visited.add(name);
			recursionStack.add(name);

			const node = this.nodes.get(name);
			if (!node) return false;

			for (const dep of node.dependencies) {
				if (!visited.has(dep)) {
					if (hasCycle(dep)) return true;
				} else if (recursionStack.has(dep)) {
					return true;
				}
			}

			recursionStack.delete(name);
			return false;
		};

		for (const name of this.nodes.keys()) {
			if (!visited.has(name)) {
				if (hasCycle(name)) {
					throw new Error(
						`Circular dependency detected involving module ${name}`,
					);
				}
			}
		}
	}

	getExecutionOrder(): Module[] {
		const order: Module[] = [];
		const visited = new Set<string>();

		const visit = (name: string) => {
			if (visited.has(name)) return;
			visited.add(name);

			const node = this.nodes.get(name);
			if (!node) return;

			for (const dep of node.dependencies) {
				visit(dep);
			}

			order.push(node.module);
		};

		for (const name of this.nodes.keys()) {
			visit(name);
		}

		return order;
	}

	getConcurrentGroups(): Module[][] {
		const groups: Module[][] = [];
		const processed = new Set<string>();

		while (processed.size < this.nodes.size) {
			const group: Module[] = [];

			for (const [name, node] of this.nodes) {
				if (processed.has(name)) continue;

				const dependenciesMet = Array.from(node.dependencies).every((dep) =>
					processed.has(dep),
				);

				if (dependenciesMet) {
					group.push(node.module);
				}
			}

			if (group.length === 0) {
				throw new Error(
					"Unable to resolve dependencies - possible circular dependency",
				);
			}

			groups.push(group);
			group.forEach((m) => processed.add(m.name));
		}

		return groups;
	}

	filter(predicate: (module: Module) => boolean): ModuleDAG {
		const filtered = new ModuleDAG();
		const includedModules = new Set<string>();

		for (const node of this.nodes.values()) {
			if (predicate(node.module)) {
				includedModules.add(node.module.name);
			}
		}

		const addWithDeps = (name: string) => {
			if (includedModules.has(name)) return;

			const node = this.nodes.get(name);
			if (!node) return;

			includedModules.add(name);
			for (const dep of node.dependencies) {
				addWithDeps(dep);
			}
		};

		for (const name of Array.from(includedModules)) {
			addWithDeps(name);
		}

		for (const name of includedModules) {
			const node = this.nodes.get(name);
			if (node) {
				filtered.addModule(node.module);
			}
		}

		filtered.build();
		return filtered;
	}
}
