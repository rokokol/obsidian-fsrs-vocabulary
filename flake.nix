{
  description = "FSRS Vocabulary — Obsidian spaced-repetition dictionary plugin";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          # Node 22 matches CI (.github/workflows). npm ships with nodejs.
          packages = with pkgs; [
            nodejs_22
            typescript-language-server
          ];

          shellHook = ''
            echo "FSRS Vocabulary dev shell — node $(node --version), npm $(npm --version)"
            echo "  npm ci          install deps"
            echo "  npm run dev     watch build"
            echo "  npm run check   typecheck + lint + test"
          '';
        };

        # Without this output `nix fmt` does nothing here and a gate has nothing to run.
        # nixfmt-tree walks the tree rather than the files it is handed, so one command
        # covers every .nix file the repository grows
        formatter = pkgs.nixfmt-tree;
      }
    );
}
