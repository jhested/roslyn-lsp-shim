// Minimal sample using a built-in source generator (GeneratedRegex,
// available in .NET 7+). The generator emits the body of EmailRegex
// into an in-memory document that the Roslyn LSP exposes via its
// `roslyn-source-generated://` URI scheme. The shim's job is to make
// `textDocument/implementation` on this symbol resolve to a navigable
// file:// path containing the generated source.

using System.Text.RegularExpressions;

namespace Sample;

public partial class EmailValidator
{
    [GeneratedRegex(@"^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$")]
    public static partial Regex EmailRegex();

    public static bool IsValid(string input) => EmailRegex().IsMatch(input);
}
