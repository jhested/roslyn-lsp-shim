// This file mirrors Jimmi's Rules.Oapi setup: it lives in a project that
// ProjectReferences the producer, and consumes types that exist only as
// source-generator output of the producer (Sample.Producer.Generated.IGreeter
// and GreetResponse). The point of this file is to be the cursor target
// for go-to-definition probes from the e2e test.

using Sample.Producer.Generated;

namespace Sample.Consumer;

public sealed class StaticGreeter : IGreeter
{
    public string Greet(string name) => $"Hello {name}!";

    public GreetResponse GreetWithEnvelope(string name) =>
        new(Greet(name));
}
