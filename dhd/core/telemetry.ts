import { trace, Span, SpanStatusCode } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import type { SideEffect } from './action.ts';

export function getTelemetry() {
  const tracer = trace.getTracer('rawkOS', '1.0.0');
  
  return {
    tracer,
    logger: console,
    startExecutionSpan(name: string): Span {
      return tracer.startSpan(name);
    },
    startGroupSpan(index: number, total: number, parentSpan?: Span): Span {
      return tracer.startSpan(`group-${index}`, {
        attributes: { groupIndex: index, groupSize: total }
      });
    },
    startModuleSpan(moduleName: string, parentSpan?: Span): Span {
      return tracer.startSpan(`module-${moduleName}`, {
        attributes: { module: moduleName }
      });
    },
    endSpanSuccess(span: Span): void {
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    },
    endSpanError(span: Span, error: Error): void {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.end();
    },
    recordSideEffects(span: Span, effects: SideEffect[]): void {
      span.setAttribute('sideEffects', JSON.stringify(effects));
    },
    logError(moduleName: string, error: Error): void {
      console.error(`[${moduleName}] Error:`, error);
    },
    logModuleOutput(moduleName: string, data: string, severity: SeverityNumber): void {
      console.log(`[${moduleName}] ${data}`);
    }
  };
}