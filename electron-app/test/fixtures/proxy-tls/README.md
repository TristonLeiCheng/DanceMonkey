These are public, disposable TLS fixtures for local proxy tests. The private key
was generated solely for this test suite and protects no real service or data.
Never install this certificate as a trusted system root or use the key in a deployment.
The trusted test injects this CA into its own ProxyAgent; production validation
must reject the same certificate.
