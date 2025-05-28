import React, { useState, useEffect } from 'react';
import { render, Box, Text } from 'ink';
import type { Module } from '../module.ts';
import type { SideEffect } from '../action.ts';
import { EventEmitter } from 'node:events';

interface ModuleState {
	name: string;
	status: 'pending' | 'running' | 'success' | 'error';
	startTime?: number;
	error?: Error;
}

interface SimpleVisualizerProps {
	plannedEffects?: Map<string, SideEffect[]>;
	modules: ModuleState[];
	startTime: number;
	isComplete: boolean;
	verbose: boolean;
}

const SimpleVisualizerComponent: React.FC<SimpleVisualizerProps> = ({ 
	plannedEffects, 
	modules, 
	startTime, 
	isComplete,
	verbose 
}) => {
	// Show plan if provided and no modules yet
	if (plannedEffects && modules.length === 0) {
		const hasEffects = Array.from(plannedEffects.values()).some(e => e.length > 0);
		
		return (
			<Box flexDirection="column" marginTop={1}>
				<Text bold color="blue">📋 Execution Plan:</Text>
				<Text> </Text>
				{!hasEffects ? (
					<Text color="green">✓ Everything is up to date - no changes needed</Text>
				) : (
					<Box flexDirection="column">
						{Array.from(plannedEffects).map(([moduleName, effects]) => {
							if (effects.length === 0) return null;
							
							const groupedEffects = new Map<string, SideEffect[]>();
							for (const effect of effects) {
								const existing = groupedEffects.get(effect.type) || [];
								existing.push(effect);
								groupedEffects.set(effect.type, existing);
							}
							
							return (
								<Box key={moduleName} flexDirection="column" marginBottom={1}>
									<Text color="yellow">  {moduleName}:</Text>
									{Array.from(groupedEffects).map(([type, typeEffects]) => {
										const icon = getEffectIcon(type);
										return (
											<Box key={type} marginLeft={4}>
												<Text color="cyan">{icon} {type}: {typeEffects.length} operation{typeEffects.length !== 1 ? 's' : ''}</Text>
											</Box>
										);
									})}
								</Box>
							);
						})}
					</Box>
				)}
			</Box>
		);
	}

	// Show execution progress
	const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
	const completedCount = modules.filter(m => m.status === 'success').length;
	const failedCount = modules.filter(m => m.status === 'error').length;
	const totalCount = modules.length;

	return (
		<Box flexDirection="column">
			{modules.length > 0 && !isComplete && (
				<>
					<Text bold color="blue">🚀 Executing {totalCount} module{totalCount !== 1 ? 's' : ''}...</Text>
					<Text> </Text>
				</>
			)}
			
			{modules.map(module => (
				<Box key={module.name} marginBottom={1}>
					{module.status === 'pending' && <Text color="gray">◯ Pending: {module.name}</Text>}
					{module.status === 'running' && <Text color="blue">▶ Running: {module.name}</Text>}
					{module.status === 'success' && <Text color="green">✓ Completed: {module.name}</Text>}
					{module.status === 'error' && (
						<Box flexDirection="column">
							<Text color="red">✗ Failed: {module.name}</Text>
							{verbose && module.error && (
								<Text color="red" dimColor marginLeft={2}>Error: {module.error.message}</Text>
							)}
						</Box>
					)}
				</Box>
			))}
			
			{isComplete && (
				<>
					<Text> </Text>
					<Text color="gray">{'─'.repeat(60)}</Text>
					<Text> </Text>
					{failedCount === 0 ? (
						<Text bold color="green">✅ All {completedCount} modules executed successfully in {elapsed}s</Text>
					) : (
						<Box flexDirection="column">
							<Text bold color="yellow">📊 Execution Summary:</Text>
							<Text color="green">   ✓ Successful: {completedCount}</Text>
							{failedCount > 0 && (
								<>
									<Text color="red">   ✗ Failed: {failedCount}</Text>
									<Text color="red">      {modules.filter(m => m.status === 'error').map(m => m.name).join(', ')}</Text>
								</>
							)}
							<Text color="gray">   ⏱ Time: {elapsed}s</Text>
							<Text> </Text>
							{failedCount > 0 && <Text bold color="red">❌ Execution completed with errors</Text>}
						</Box>
					)}
				</>
			)}
		</Box>
	);
};

function getEffectIcon(type: string): string {
	const icons: Record<string, string> = {
		file_create: "📄",
		file_modify: "📝",
		file_delete: "🗑️",
		symlink_create: "🔗",
		package_install: "📦",
		command_run: "⚡",
		systemd_unit: "⚙️",
		dconf_write: "🔧",
	};
	return icons[type] || "•";
}

export class InkSimpleVisualizer {
	private verbose: boolean;
	private inkInstance: any;
	private moduleStates = new Map<string, ModuleState>();
	private plannedEffects?: Map<string, SideEffect[]>;
	private startTime = Date.now();
	private isComplete = false;

	constructor(verbose = false) {
		this.verbose = verbose;
	}

	showPlan(effects: Map<string, SideEffect[]>) {
		this.plannedEffects = effects;
		
		// Show the plan
		if (this.inkInstance) {
			this.inkInstance.unmount();
		}
		
		this.inkInstance = render(
			<SimpleVisualizerComponent
				plannedEffects={effects}
				modules={[]}
				startTime={this.startTime}
				isComplete={false}
				verbose={this.verbose}
			/>
		);
		
		// Clear after showing plan
		setTimeout(() => {
			if (this.inkInstance) {
				this.inkInstance.unmount();
			}
		}, 100);
	}

	onGroupStart(modules: Module[]) {
		// Initialize module states
		for (const module of modules) {
			this.moduleStates.set(module.name, {
				name: module.name,
				status: 'pending'
			});
		}
		
		this.renderCurrent();
	}

	onModuleStart(module: Module) {
		const state = this.moduleStates.get(module.name);
		if (state) {
			state.status = 'running';
			state.startTime = Date.now();
		}
		this.renderCurrent();
	}

	onModuleComplete(module: Module) {
		const state = this.moduleStates.get(module.name);
		if (state) {
			state.status = 'success';
		}
		this.renderCurrent();
	}

	onModuleError(module: Module, error: Error) {
		const state = this.moduleStates.get(module.name);
		if (state) {
			state.status = 'error';
			state.error = error;
		}
		this.renderCurrent();
	}

	onGroupComplete(modules: Module[]) {
		this.isComplete = true;
		this.renderCurrent();
	}

	showSummary(success: boolean) {
		this.isComplete = true;
		this.renderCurrent();
		
		// Keep the summary visible
		// The process will exit naturally
	}

	private renderCurrent() {
		if (this.inkInstance) {
			this.inkInstance.unmount();
		}
		
		const modules = Array.from(this.moduleStates.values());
		
		this.inkInstance = render(
			<SimpleVisualizerComponent
				plannedEffects={undefined}
				modules={modules}
				startTime={this.startTime}
				isComplete={this.isComplete}
				verbose={this.verbose}
			/>
		);
	}
}