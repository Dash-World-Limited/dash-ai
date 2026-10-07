@file:Suppress("unused", "UNUSED_PARAMETER")
package androidx.compose.ui.res
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.platform.LocalDensity
import com.dashworldng.ai.DesktopResources
import org.xml.sax.InputSource
import java.io.File

/**
 * Desktop stand-ins for the Android resource loaders. Drawables are the app's real vector XML files,
 * loaded with Compose Desktop's Android-vector parser, so screenshots show the real artwork.
 */
@Composable fun painterResource(id: Int): Painter {
    val density = LocalDensity.current
    val name = DesktopResources.drawables[id] ?: error("Unknown drawable id $id")
    val vector = remember(id) {
        File(DesktopResources.drawableDir, "$name.xml").inputStream().use { loadXmlImageVector(InputSource(it), density) }
    }
    return rememberVectorPainter(vector)
}
@Composable fun stringResource(id: Int): String = TODO()
