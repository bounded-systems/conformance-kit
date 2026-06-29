{
  description = "@bounded-systems/conformance-kit — fail-closed web-conformance gates + generators as reproducible CLIs";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        version = "0.5.0";

        # Every ck-* bin the package.json declares (kept in sync with "bin").
        bins = [
          "ck-axe-gate"
          "ck-vuln-gate"
          "ck-html-validator-gate"
          "ck-baseline-gate"
          "ck-palette-gate"
          "ck-typography-gate"
          "ck-target-size-gate"
          "ck-opacity-contrast-gate"
          "ck-likeness-gate"
          "ck-pairing-extractor"
          "ck-token-a11y"
          "ck-jargon-gate"
          "ck-seo-gate"
          "ck-shacl-runner"
          "ck-readability-gate"
          "ck-commonmark-runner"
          "ck-gen-sbom"
          "ck-check-sbom"
          "ck-gen-sitemanifest"
          "ck-gen-provenance"
          "ck-verify-site"
          "ck-http-probe"
          "ck-structure-audit"
          "ck-gen-cid"
          "ck-gen-identity"
          "ck-gen-snapshots"
          "ck-gen-print-snapshots"
        ];

        kit = pkgs.buildNpmPackage {
          pname = "conformance-kit";
          inherit version;
          src = ./.;
          npmDepsHash = "sha256-cnzJA3NEG9ZkB2dZzIyXFJKjJmX8czariuTi7NjYg40=";
          dontNpmBuild = true; # the kit has no build step (pure .mjs)

          nativeBuildInputs = [ pkgs.makeWrapper ];
          # Bundle the runtimes the gates shell out to, so each bin is self-contained
          # (the way tezcatl-flake bundles WebKit):
          #   • vnu  → a JRE (the Nu HTML Checker is a Java jar)
          #   • npm  → nodejs, for `ck-vuln-gate`'s `npm audit`
          # The other gates are pure Node + their bundled node_modules. (axe needs a
          # browser the consumer supplies via $AXE_RUNNER: tezcatl / Playwright.)
          postInstall = ''
            wrapProgram $out/bin/ck-html-validator-gate \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.jre ]}
            wrapProgram $out/bin/ck-vuln-gate \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.nodejs ]}
          '';

          meta = with pkgs.lib; {
            description = "Site-agnostic web-conformance toolkit: fail-closed gates + provenance generators, as reproducible CLIs.";
            homepage = "https://github.com/bounded-systems/conformance-kit";
            license = licenses.mit;
            mainProgram = "ck-vuln-gate";
          };
        };
      in
      {
        packages.default = kit;
        packages.conformance-kit = kit;

        # `nix run github:bounded-systems/conformance-kit#ck-axe-gate -- dist`
        apps = nixpkgs.lib.genAttrs bins (name: {
          type = "app";
          program = "${kit}/bin/${name}";
        }) // {
          default = { type = "app"; program = "${kit}/bin/ck-vuln-gate"; };
        };
      });
}
