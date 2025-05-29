import React, { useState, useEffect, useCallback } from 'react';
import { render, Box, Text, useInput, useApp, Spacer } from 'ink';
import type { Module } from '../module.ts';
import type { SideEffect } from '../action.ts';
import { EventEmitter } from 'node:events';

interface ModuleState {
	name: string;
	status: 'pending' | 'running' | 'success' | 'error' | 'waiting-input';
	startTime?: number;
	output: string[];
	error?: Error;
	needsInput: boolean;
}

interface Props {
	modules: ModuleState[];
	startTime: number;
	isComplete: boolean;
	verbose: boolean;
	onExit: () => void;
}

const InteractiveTUI: React.FC<Props> = ({ modules, startTime, isComplete, verbose, onExit }) => {
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [scrollOffset, setScrollOffset] = useState(0);
	const { exit } = useApp();
	
	// Terminal dimensions
	const termHeight = process.stdout.rows || 30;
	const termWidth = process.stdout.columns || 80;
	const leftWidth = Math.floor(termWidth * 0.4);
	const rightWidth = termWidth - leftWidth - 3;
	
	// Calculate content area
	const headerLines = 3;
	const footerLines = 4;
	const contentHeight = termHeight - headerLines - footerLines;
	
	// Calculate elapsed time
	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	
	// Handle keyboard input
	useInput((input, key) => {
		if (input === 'q') {
			onExit();
			exit();
		}
		
		if (key.downArrow || input === 'j') {
			const newIndex = Math.min(selectedIndex + 1, modules.length - 1);
			setSelectedIndex(newIndex);
			
			// Adjust scroll if needed
			if (newIndex >= scrollOffset + contentHeight) {
				setScrollOffset(newIndex - contentHeight + 1);
			}
		}
		
		if (key.upArrow || input === 'k') {
			const newIndex = Math.max(selectedIndex - 1, 0);
			setSelectedIndex(newIndex);
			
			// Adjust scroll if needed
			if (newIndex < scrollOffset) {
				setScrollOffset(newIndex);
			}
		}
		
		if (input === 'i') {
			// Jump to module needing input
			const inputIndex = modules.findIndex(m => m.needsInput);
			if (inputIndex >= 0) {
				setSelectedIndex(inputIndex);
				// Adjust scroll to show the selected module
				if (inputIndex < scrollOffset || inputIndex >= scrollOffset + contentHeight) {
					setScrollOffset(Math.max(0, inputIndex - Math.floor(contentHeight / 2)));
				}
			}
		}
	});
	
	// Get visible modules
	const visibleModules = modules.slice(scrollOffset, scrollOffset + contentHeight);
	
	// Count statistics
	const completedCount = modules.filter(m => m.status === 'success').length;
	const failedCount = modules.filter(m => m.status === 'error').length;
	const runningCount = modules.filter(m => m.status === 'running').length;
	const pendingCount = modules.filter(m => m.status === 'pending').length;
	
	// Get selected module output
	const selectedModule = modules[selectedIndex];
	const moduleOutput = selectedModule?.output || [];
	
	return (
		<Box flexDirection="column" height={termHeight}>
			{/* Header */}
			<Box flexDirection="column">
				<Box>
					<Text bold color="blue">🚀 RawkOS Module Execution</Text>
					<Text color="gray"> ({elapsed}s)</Text>
					{modules.length > contentHeight && (
						<Text color="gray"> [{scrollOffset + 1}/{modules.length - contentHeight + 1}]</Text>
					)}
				</Box>
				<Text color="gray">{'─'.repeat(termWidth)}</Text>
			</Box>
			
			{/* Content area */}
			<Box flexGrow={1} marginTop={1} marginBottom={1}>
				{/* Left panel - Module list */}
				<Box flexDirection="column" width={leftWidth}>
					{visibleModules.map((module, idx) => {
						const globalIdx = idx + scrollOffset;
						const isSelected = globalIdx === selectedIndex;
						
						let statusIcon = '';
						let statusColor: string = 'gray';
						
						switch (module.status) {
							case 'pending':
								statusIcon = '◯';
								statusColor = 'gray';
								break;
							case 'running':
								statusIcon = module.needsInput ? '⌨' : '⟳';
								statusColor = module.needsInput ? 'yellow' : 'blue';
								break;
							case 'success':
								statusIcon = '✓';
								statusColor = 'green';
								break;
							case 'error':
								statusIcon = '✗';
								statusColor = 'red';
								break;
							case 'waiting-input':
								statusIcon = '⏸';
								statusColor = 'yellow';
								break;
						}
						
						return (
							<Box key={module.name}>
								<Text 
									color={statusColor}
									backgroundColor={isSelected ? 'blue' : undefined}
									bold={isSelected}
								>
									{statusIcon} {module.name.padEnd(leftWidth - 3)}
								</Text>
							</Box>
						);
					})}
					
					{/* Fill empty space */}
					{Array(Math.max(0, contentHeight - visibleModules.length)).fill(null).map((_, idx) => (
						<Text key={`empty-${idx}`}>{' '.repeat(leftWidth)}</Text>
					))}
				</Box>
				
				{/* Divider */}
				<Box flexDirection="column" marginLeft={1} marginRight={1}>
					{Array(contentHeight).fill(null).map((_, idx) => (
						<Text key={`div-${idx}`} color="gray">│</Text>
					))}
				</Box>
				
				{/* Right panel - Output */}
				<Box flexDirection="column" width={rightWidth} flexShrink={0}>
					{moduleOutput.length > 0 ? (
						moduleOutput.slice(-contentHeight).map((line, idx) => (
							<Text key={idx} wrap="truncate-end">
								{line.substring(0, rightWidth)}
							</Text>
						))
					) : (
						<Text color="gray">{selectedModule ? 'No output yet...' : 'Select a module'}</Text>
					)}
					
					{/* Fill remaining space */}
					{Array(Math.max(0, contentHeight - Math.min(moduleOutput.length, contentHeight))).fill(null).map((_, idx) => (
						<Text key={`empty-out-${idx}`}> </Text>
					))}
				</Box>
			</Box>
			
			{/* Footer */}
			<Box flexDirection="column">
				<Text color="gray">{'─'.repeat(termWidth)}</Text>
				<Box>
					{completedCount > 0 && <Text color="green">✓ {completedCount} </Text>}
					{failedCount > 0 && <Text color="red">✗ {failedCount} </Text>}
					{runningCount > 0 && <Text color="blue">⟳ {runningCount} </Text>}
					{pendingCount > 0 && <Text color="gray">◯ {pendingCount} </Text>}
					
					{isComplete && (
						<>
							<Text color="gray"> | </Text>
							<Text color="green" bold>✓ Execution complete</Text>
						</>
					)}
					
					<Spacer />
					
					<Text color="yellow">[j/k]</Text>
					<Text> Navigate </Text>
					<Text color="yellow">[i]</Text>
					<Text> Jump to input </Text>
					<Text color="yellow">[q]</Text>
					<Text> Quit</Text>
				</Box>
			</Box>
		</Box>
	);
};

export class InkInteractiveTUIVisualizer extends EventEmitter {
	private verbose: boolean;
	private inkInstance: any;
	private moduleStates = new Map<string, ModuleState>();
	private startTime = Date.now();
	private isComplete = false;
	private updateCallback?: (states: ModuleState[]) => void;

	constructor(verbose = false) {
		super();
		this.verbose = verbose;
	}

	showPlan(effects: Map<string, SideEffect[]>) {
		// Plan display can be shown separately or integrated
	}

	onGroupStart(modules: Module[]) {
		// Initialize module states
		for (const module of modules) {
			this.moduleStates.set(module.name, {
				name: module.name,
				status: 'pending',
				output: [],
				needsInput: false
			});
		}
		
		this.start();
	}

	onModuleStart(module: Module) {
		const state = this.moduleStates.get(module.name);
		if (state) {
			state.status = 'running';
			state.startTime = Date.now();
			state.output.push('▶ Starting module execution...');
		}
		this.updateView();
	}

	onModuleComplete(module: Module) {
		const state = this.moduleStates.get(module.name);
		if (state) {
			state.status = 'success';
			state.output.push('');
			state.output.push('✓ Module completed successfully');
		}
		this.updateView();
	}

	onModuleError(module: Module, error: Error) {
		const state = this.moduleStates.get(module.name);
		if (state) {
			state.status = 'error';
			state.error = error;
			state.output.push('');
			state.output.push(`✗ Error: ${error.message}`);
		}
		this.updateView();
	}

	onModuleOutput(moduleName: string, data: string) {
		const state = this.moduleStates.get(moduleName);
		if (state) {
			// Split data into lines and add each
			const lines = data.split('\n');
			for (const line of lines) {
				if (line.trim()) {
					state.output.push(line);
				}
			}
			
			// Keep only last 1000 lines
			if (state.output.length > 1000) {
				state.output = state.output.slice(-1000);
			}
			
			// Check if this looks like a password prompt
			if (data.toLowerCase().includes('password') || data.includes('sudo')) {
				state.needsInput = true;
			}
		}
		this.updateView();
	}

	onModuleNeedsInput(moduleName: string) {
		const state = this.moduleStates.get(moduleName);
		if (state) {
			state.needsInput = true;
			state.status = 'waiting-input';
			state.output.push('');
			state.output.push('⌨ Module requires input - terminal control released');
		}
		
		// Pause the TUI
		this.pauseForInput();
	}

	pauseForInput() {
		if (this.inkInstance) {
			this.inkInstance.unmount();
		}
		
		console.log('\n⌨ Input required - TUI paused\n');
		
		// Emit event for executor to handle
		this.emit('inputRequired');
	}

	resumeFromInput() {
		// Restart the TUI
		this.start();
	}

	onGroupComplete(modules: Module[]) {
		this.isComplete = true;
		this.updateView();
		this.emit('complete');
	}

	showSummary(success: boolean) {
		// Summary is integrated into the TUI
		this.isComplete = true;
		this.updateView();
	}

	start() {
		const App: React.FC = () => {
			const [moduleList, setModuleList] = useState<ModuleState[]>(
				Array.from(this.moduleStates.values())
			);
			
			useEffect(() => {
				this.updateCallback = setModuleList;
				return () => {
					this.updateCallback = undefined;
				};
			}, []);
			
			const handleExit = useCallback(() => {
				this.cleanup();
			}, []);
			
			return (
				<InteractiveTUI
					modules={moduleList}
					startTime={this.startTime}
					isComplete={this.isComplete}
					verbose={this.verbose}
					onExit={handleExit}
				/>
			);
		};
		
		this.inkInstance = render(<App />);
	}

	cleanup() {
		if (this.inkInstance) {
			this.inkInstance.unmount();
		}
		console.clear();
	}

	private updateView() {
		if (this.updateCallback) {
			const modules = Array.from(this.moduleStates.values());
			this.updateCallback([...modules]); // Create new array to trigger update
		}
	}
}