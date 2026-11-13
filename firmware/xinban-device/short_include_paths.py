"""Keep GCC's child command below Windows' 32K limit in deep checkouts.

GCC 8 expands SCons response files before spawning cc1plus. Preserve CPPPATH
for dependency scanning; shorten only the emitted include flags. No drive
mapping, machine-wide configuration, or dependency edits are required.
"""
import os

Import("env")


def relative_include_flags(target, source, env, for_signature):
    project = env.subst("$PROJECT_DIR")
    flags = []
    for directory in env.Flatten(env["CPPPATH"]):
        absolute = env.Dir(env.subst(str(directory))).get_abspath()
        try:
            relative = os.path.relpath(absolute, project)
            path = relative if len(relative) < len(absolute) else absolute
        except ValueError:  # External dependencies on a different Windows drive.
            path = absolute
        flags.append("-I" + path.replace("\\", "/"))
    return flags


if os.name == "nt":
    env.Replace(_CPPINCFLAGS=relative_include_flags)
