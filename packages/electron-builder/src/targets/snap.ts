import { LinuxTargetHelper } from "./LinuxTargetHelper"
import { LinuxPackager } from "../linuxPackager"
import { log } from "electron-builder-util/out/log"
import { SnapOptions } from "../options/linuxOptions"
import { emptyDir, writeFile, copy } from "fs-extra-p"
import * as path from "path"
import { safeDump } from "js-yaml"
import { spawn } from "electron-builder-util"
import { homedir } from "os"
import { Target, Arch, toLinuxArchString } from "electron-builder-core"

export default class SnapTarget extends Target {
  private readonly options: SnapOptions = Object.assign({}, this.packager.platformSpecificBuildOptions, (<any>this.packager.config)[this.name])

  constructor(name: string, private readonly packager: LinuxPackager, private readonly helper: LinuxTargetHelper, readonly outDir: string) {
    super(name)
  }

  async build(appOutDir: string, arch: Arch): Promise<any> {
    log(`Building Snap for arch ${Arch[arch]}`)

    const packager = this.packager
    const appInfo = packager.appInfo
    const options = this.options

    const snapDir = `${appOutDir}-snap`
    await emptyDir(snapDir)

    const extraSnapSourceDir = path.join(snapDir, ".extra")
    const isUseUbuntuPlatform = options.ubuntuAppPlatformContent != null
    if (isUseUbuntuPlatform) {
      // ubuntu-app-platform requires empty directory
      await emptyDir(path.join(extraSnapSourceDir, "ubuntu-app-platform"))
    }

    const snap: any = {}
    snap.name = packager.executableName
    snap.version = appInfo.version
    snap.summary = options.summary || appInfo.productName
    snap.description = this.helper.getDescription(options)
    snap.confinement = options.confinement || "strict"
    snap.grade = options.grade || "stable"

    await this.helper.icons
    if (this.helper.maxIconPath != null) {
      snap.icon = "setup/gui/icon.png"
      await copy(this.helper.maxIconPath, path.join(snapDir, "setup", "gui", "icon.png"))
    }

    await this.helper.computeDesktopEntry(this.options, `${snap.name}`, path.join(snapDir, "setup", "gui", `${snap.name}.desktop`), {
      "Icon": "${SNAP}/meta/gui/icon.png"
    })

    if (options.assumes != null) {
      if (!Array.isArray(options.assumes)) {
        throw new Error("snap.assumes must be an array of strings")
      }
      snap.assumes = options.assumes
    }

    snap.apps = {
      [snap.name]: {
        command: `desktop-launch $SNAP/${packager.executableName}`,
        plugs: replaceDefault(options.plugs, ["home", "x11", "unity7", "browser-support", "network", "gsettings", "pulseaudio", "opengl"])
      }
    }

    if (isUseUbuntuPlatform) {
      snap.apps[snap.name].plugs.push("platform")
      snap.plugs = {
        platform: {
          interface: "content",
          content: "ubuntu-app-platform1",
          target: "ubuntu-app-platform",
          "default-provider": "ubuntu-app-platform",
        }
      }
    }

    // libxss1, libasound2, gconf2 - was "error while loading shared libraries: libXss.so.1" on Xubuntu 16.04
    const isUseDocker = process.platform !== "linux"

    const defaultStagePackages = (isUseUbuntuPlatform ? ["libnss3"] : ["libnotify4", "libappindicator1", "libxtst6", "libnss3", "libxss1", "fontconfig-config", "gconf2", "libasound2", "pulseaudio"])
    snap.parts = {
      app: {
        plugin: "dump",
        "stage-packages": replaceDefault(options.stagePackages, defaultStagePackages),
        source: isUseDocker ? `/out/${path.basename(appOutDir)}` : appOutDir,
        after: isUseUbuntuPlatform ? ["extra", "desktop-ubuntu-app-platform"] : ["desktop-glib-only"]
      }
    }

    if (isUseUbuntuPlatform) {
      snap.parts.extra = {
        plugin: "dump",
        source: isUseDocker ? `/out/${path.basename(snapDir)}/${path.basename(extraSnapSourceDir)}` : extraSnapSourceDir
      }
    }

    if (packager.packagerOptions.effectiveOptionComputed != null && await packager.packagerOptions.effectiveOptionComputed(snap)) {
      return
    }

    const snapcraft = path.join(snapDir, "snapcraft.yaml")
    await writeFile(snapcraft, safeDump(snap, {lineWidth: 160}))

    const snapName = `${snap.name}_${snap.version}_${toLinuxArchString(arch)}.snap`
    const resultFile = path.join(this.outDir, snapName)

    if (isUseDocker) {
      await spawn("docker", ["run", "--rm",
        "-v", `${packager.info.projectDir}:/project`,
        "-v", `${homedir()}/.electron:/root/.electron`,
        // dist dir can be outside of project dir
        "-v", `${this.outDir}:/out`,
        "electronuserland/electron-builder:latest",
        "/bin/bash", "-c", `snapcraft --version && cp -R /out/${path.basename(snapDir)} /s/ && cd /s && snapcraft snap --target-arch ${toLinuxArchString(arch)} -o /out/${snapName}`], {
        cwd: packager.info.projectDir,
        stdio: ["ignore", "inherit", "inherit"],
      })
    }
    else {
      await spawn("snapcraft", ["snap", "--target-arch", toLinuxArchString(arch), "-o", resultFile], {
        cwd: snapDir,
        stdio: ["ignore", "inherit", "pipe"],
      })
    }
    packager.dispatchArtifactCreated(resultFile, this)
  }
}

function replaceDefault(inList: Array<string> | n, defaultList: Array<string>): Array<string> {
  if (inList == null) {
    return defaultList
  }

  const index = inList.indexOf("default")
  if (index >= 0) {
    let list = inList.slice(0, index)
    list.push(...defaultList)
    if (index != (inList.length - 1)) {
      list.push(...inList.slice(index + 1))
    }
    inList = list
  }
  return inList
}