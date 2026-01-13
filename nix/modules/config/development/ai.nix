{
  flake.nixosModules.ai = {
    # Codebase Indexing for AI Agents
    services.qdrant.enable = true;
  };
}
