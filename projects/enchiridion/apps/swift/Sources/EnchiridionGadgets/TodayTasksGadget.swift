// TodayTasksGadget.swift
// EnchiridionGadgets
//
// The ONE proof-of-concept UI gadget (plan §Gadgets P4: "one UI gadget to
// prove the bridge"; task brief: "This is explicitly 'prove the bridge,'
// not a polished feature"). Plain HTML + inline `<script>`, no framework —
// it calls the exact same `window.enchiridionGadget.graphQuery(view,
// params)` API `GadgetBridgeJavaScriptShim` injects into every gadget,
// requesting the real `nodesByTag` view
// (`workers/gadget-host/src/graph-query-views.ts`) with `tagID: "task"` —
// there is no synthetic/mocked view name here, this is the actual
// server-shaped request a `GadgetBridge` holding a `{capabilityType:
// .graphQuery, views: ["nodesByTag"]}` grant would authorize and forward.
//
// A real "today's tasks" filter (due-today / not-yet-scheduled) needs a
// purpose-built server-side view — `nodesByTag` alone returns every node
// carrying the `task` tag, not "today's". Out of scope for a bridge proof
// (task brief: "a small read-only view listing today's tasks via a
// graphQuery-shaped bridge call" — read literally, the point is the
// bridge call's shape, not a real due-date filter); left as an explicit
// TODO rather than silently mislabeled.
public enum TodayTasksGadget {
  public static let name = "Today's Tasks"

  /// Handed to `GadgetWebViewHost(content:)`. `bodyHTML` only — see
  /// `GadgetContent`'s doc comment for why the host, not this gadget,
  /// owns the `<head>`/CSP wrapper.
  public static let content = GadgetContent(bodyHTML: bodyHTML)

  private static let bodyHTML = """
    <ul id="task-list" role="list"></ul>
    <p id="task-status">Loading tasks…</p>
    <style>
      #task-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      #task-list li {
        padding: 6px 0;
        border-bottom: 1px solid var(--enchiridion-separator-color);
      }
      #task-list li:last-child {
        border-bottom: none;
      }
      #task-status {
        color: var(--enchiridion-secondary-text-color);
        font-style: italic;
        margin: 0;
      }
      #task-status.hidden {
        display: none;
      }
    </style>
    <script>
      (function () {
        var list = document.getElementById('task-list');
        var status = document.getElementById('task-status');

        window.enchiridionGadget.graphQuery('nodesByTag', { tagID: 'task' })
          .then(function (result) {
            var nodes = (result && result.nodes) || [];
            if (nodes.length === 0) {
              status.textContent = 'No tasks.';
              return;
            }
            status.classList.add('hidden');
            nodes.forEach(function (node) {
              var item = document.createElement('li');
              item.textContent = (node && (node.title || node.id)) || 'Untitled task';
              list.appendChild(item);
            });
          })
          .catch(function (error) {
            status.textContent = "Couldn't load tasks: " + (error && error.message ? error.message : 'unknown error');
          });
      })();
    </script>
    """
}
